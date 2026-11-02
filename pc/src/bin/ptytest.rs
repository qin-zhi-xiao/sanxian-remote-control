// 最小 ConPTY 复现：CreatePseudoConsole + CreateProcessW + 读写
// 运行：cargo run --bin ptytest
use std::ffi::OsStr;
use std::io::{Read, Write};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::FromRawHandle;
use std::ptr;

type Handle = *mut core::ffi::c_void;

#[repr(C)]
#[derive(Default)]
struct StartupInfoW {
    cb: u32,
    lpReserved: *mut u16,
    lpDesktop: *mut u16,
    lpTitle: *mut u16,
    dwX: u32,
    dwY: u32,
    dwXSize: u32,
    dwYSize: u32,
    dwXCountChars: u32,
    dwYCountChars: u32,
    dwFillAttribute: u32,
    dwFlags: u32,
    wShowWindow: u16,
    cbReserved2: u16,
    lpReserved2: *mut u8,
    hStdInput: Handle,
    hStdOutput: Handle,
    hStdError: Handle,
}

#[repr(C)]
struct StartupInfoExW {
    si: StartupInfoW,
    attr: *mut core::ffi::c_void,
}

#[repr(C)]
#[derive(Default)]
struct ProcessInformation {
    hProcess: Handle,
    hThread: Handle,
    pid: u32,
    tid: u32,
}

#[link(name = "kernel32")]
extern "system" {
    fn CreatePipe(r: *mut Handle, w: *mut Handle, sa: *mut core::ffi::c_void, n: u32) -> i32;
    fn CloseHandle(h: Handle) -> i32;
    fn CreatePseudoConsole(size: u32, input: Handle, output: Handle, flags: u32, out: *mut Handle) -> i32;
    fn InitializeProcThreadAttributeList(l: *mut core::ffi::c_void, c: u32, f: u32, size: *mut usize) -> i32;
    fn UpdateProcThreadAttribute(l: *mut core::ffi::c_void, f: u32, attr: usize, v: *mut core::ffi::c_void, sz: usize, p: *mut core::ffi::c_void, r: *mut usize) -> i32;
    fn DeleteProcThreadAttributeList(l: *mut core::ffi::c_void);
    fn CreateProcessW(app: *const u16, cmd: *mut u16, pa: *mut core::ffi::c_void, ta: *mut core::ffi::c_void, inh: i32, fl: u32, env: *mut core::ffi::c_void, cwd: *const u16, si: *mut StartupInfoW, pi: *mut ProcessInformation) -> i32;
    fn GetConsoleWindow() -> Handle;
    fn AttachConsole(pid: u32) -> i32;
}

fn wide(s: &str) -> Vec<u16> {
    OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
}

fn main() {
    unsafe {
        println!("[test] 开始");
        println!("[test] 当前进程有没有控制台: {}", GetConsoleWindow().is_null() == false);

        let (mut in_r, mut in_w): (Handle, Handle) = (ptr::null_mut(), ptr::null_mut());
        let (mut out_r, mut out_w): (Handle, Handle) = (ptr::null_mut(), ptr::null_mut());
        assert!(CreatePipe(&mut in_r, &mut in_w, ptr::null_mut(), 0) != 0);
        assert!(CreatePipe(&mut out_r, &mut out_w, ptr::null_mut(), 0) != 0);

        let size: u32 = (120u32 << 16) | 40u32;
        let mut pc: Handle = ptr::null_mut();
        let hr = CreatePseudoConsole(size, in_r, out_w, 0, &mut pc);
        println!("[test] CreatePseudoConsole -> {} (hPC={:?})", hr, pc);

        let mut list_size: usize = 0;
        InitializeProcThreadAttributeList(ptr::null_mut(), 1, 0, &mut list_size);
        println!("[test] 属性列表需要 {} 字节", list_size);
        let mut mem: Vec<usize> = vec![0; (list_size + 7) / 8];
        let list = mem.as_mut_ptr() as *mut core::ffi::c_void;
        let ok1 = InitializeProcThreadAttributeList(list, 1, 0, &mut list_size);
        let ok2 = UpdateProcThreadAttribute(list, 0, 0x0002_0016, pc as *mut core::ffi::c_void, std::mem::size_of::<Handle>(), ptr::null_mut(), ptr::null_mut());
        println!("[test] InitAttr={} UpdateAttr={}", ok1, ok2);

        let mut si: StartupInfoExW = std::mem::zeroed();
        si.si.cb = std::mem::size_of::<StartupInfoExW>() as u32;
        si.attr = list;
        let mut pi: ProcessInformation = std::mem::zeroed();

        let mut cmd = wide("cmd.exe /K chcp 65001>nul");
        let ok = CreateProcessW(
            ptr::null(), cmd.as_mut_ptr(), ptr::null_mut(), ptr::null_mut(), 1,
            0x0008_0000, // EXTENDED_STARTUPINFO_PRESENT
            ptr::null_mut(), ptr::null(), &mut si.si, &mut pi,
        );
        println!("[test] CreateProcessW={} pid={} err={:?}", ok, pi.pid, std::io::Error::last_os_error());

        CloseHandle(in_r);
        CloseHandle(out_w);

        let mut reader = std::fs::File::from_raw_handle(out_r as _);
        let mut writer = std::fs::File::from_raw_handle(in_w as _);

        // 先读 2 秒初始输出
        let mut buf = vec![0u8; 8192];
        let t0 = std::time::Instant::now();
        println!("[test] 发送 echo hello-pty");
        let _ = writer.write_all(b"echo hello-pty\r\n");
        let _ = writer.flush();
        while t0.elapsed().as_secs() < 4 {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let s = String::from_utf8_lossy(&buf[..n]).to_string();
                    for line in s.split('\n') {
                        println!("R> {}", line.replace(char::from(27), "<ESC>").replace(char::from(13), "\\r"));
                    }
                }
                Err(e) => {
                    println!("[read err] {}", e);
                    break;
                }
            }
        }
        println!("[test] 结束");
    }
}
