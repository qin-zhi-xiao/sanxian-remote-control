// 快传 · 电脑控制端 (kuaichuan.exe)
// 零依赖实现：HTTP 服务 + 命令执行 + 多品牌 Agent 探测
//
// 用法：
//   kuaichuan.exe                 # 默认 127.0.0.1:8765，自动生成配对码
//   kuaichuan.exe --lan           # 监听 0.0.0.0，供手机/局域网访问
//   kuaichuan.exe --port 9000 --token 123456
//   kuaichuan.exe --unsafe        # 关闭危险命令拦截（默认拦截）
//
// 接口（除 /ping 外都需要请求头 X-KC-Token）：
//   GET  /ping                连通性探测
//   GET  /info                机器信息 + 已安装 Agent 列表
//   GET  /agents              只取 Agent 列表
//   POST /exec                {"cmd":"whoami","cwd":"C:\\\\","timeoutMs":60000}
//   POST /agent               {"agent":"claude","prompt":"..."}  (v0.2 预留，当前返回 not-implemented)

use std::env;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const VERSION: &str = "1.4.0";
static SESSION_CWD: Mutex<Option<String>> = Mutex::new(None);

fn get_cwd() -> String {
    SESSION_CWD.lock().ok().and_then(|g| g.clone()).unwrap_or_default()
}
fn set_cwd(v: &str) {
    if let Ok(mut g) = SESSION_CWD.lock() { *g = Some(v.to_string()); }
}
const MAX_OUT: usize = 8192;

struct Config {
    port: u16,
    token: String,
    lan: bool,
    unsafe_mode: bool,
    timeout_ms: u64,
    // 云模式
    cloud: bool,
    env_id: String,
    api_key: String,
    device_code: String,
    project: String,
    gw: bool,
    gw_url: String,
}

#[derive(Clone)]
struct AgentInfo {
    name: String,
    exe: String,
    path: String,
    version: String,
}

#[derive(Clone)]
struct App {
    cfg: Arc<Config>,
    agents: Arc<Mutex<Vec<AgentInfo>>>,
}

fn klog(msg: &str) {
    use std::io::Write;
    let path = std::env::current_exe().ok()
        .and_then(|p| p.parent().map(|d| d.join("gw.log")));
    if let Some(p) = path {
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(p) {
            let _ = writeln!(f, "{}", msg);
        }
    }
}

fn main() {
    #[cfg(windows)]
    unsafe {
        // 关键：本进程不能持有控制台，否则子进程会继承它而不是伪终端
        let freed = pty::FreeConsole();
        println!("[启动] FreeConsole={}", freed);
    }
    let mut cfg = Config {
        port: 8765,
        token: String::new(),
        lan: false,
        unsafe_mode: false,
        timeout_ms: 60000,
        cloud: false,
        env_id: String::from("eval-lifecycle-d7gf433u22f6c2405"),
        api_key: String::new(),
        device_code: String::new(),
        project: String::new(),
        gw: false,
        gw_url: String::new(),
    };

    let args: Vec<String> = env::args().skip(1).collect();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--port" => {
                if i + 1 < args.len() {
                    cfg.port = args[i + 1].parse().unwrap_or(8765);
                    i += 1;
                }
            }
            "--token" => {
                if i + 1 < args.len() {
                    cfg.token = args[i + 1].clone();
                    i += 1;
                }
            }
            "--lan" => cfg.lan = true,
            "--unsafe" => cfg.unsafe_mode = true,
            "--cloud" => cfg.cloud = true,
            "--env" => {
                if i + 1 < args.len() {
                    cfg.env_id = args[i + 1].clone();
                    i += 1;
                }
            }
            "--apikey" => {
                if i + 1 < args.len() {
                    cfg.api_key = args[i + 1].clone();
                    i += 1;
                }
            }
            "--code" => {
                if i + 1 < args.len() {
                    cfg.device_code = args[i + 1].clone();
                    i += 1;
                }
            }
            "--gw" => {
                cfg.gw = true;
                if i + 1 < args.len() {
                    cfg.gw_url = args[i + 1].clone();
                    i += 1;
                }
            }
            "--project" => {
                if i + 1 < args.len() {
                    cfg.project = args[i + 1].clone();
                    i += 1;
                }
            }
            "--help" | "-h" => {
                print_help();
                return;
            }
            other => {
                eprintln!("未知参数: {}", other);
                print_help();
                return;
            }
        }
        i += 1;
    }

    if cfg.token.is_empty() {
        cfg.token = gen_token();
    }

    if cfg.gw {
        run_gateway(cfg);
        return;
    }

    if cfg.cloud {
        run_cloud(cfg);
        return;
    }

    let host = if cfg.lan { "0.0.0.0" } else { "127.0.0.1" };
    let addr = format!("{}:{}", host, cfg.port);

    let cfg = Arc::new(cfg);

    println!("==============================================");
    println!("  快传 · 电脑控制端  v{}", VERSION);
    println!("==============================================");
    println!("  监听地址 : {}", if cfg.lan { format!("http://<本机局域网IP>:{}", cfg.port) } else { format!("http://127.0.0.1:{}", cfg.port) });
    println!("  配对码   : {}", cfg.token);
    println!("  危险命令 : {}", if cfg.unsafe_mode { "不拦截（--unsafe）" } else { "拦截" });
    if !cfg.lan {
        println!();
        println!("  提示：手机要连同一台电脑，加 --lan 参数重启，让监听地址变成 0.0.0.0");
        println!("        并在 Windows 防火墙里放行 TCP {} 端口。", cfg.port);
    }
    println!();

    let listener = match TcpListener::bind(&addr) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("绑定 {} 失败: {}", addr, e);
            eprintln!("端口可能被占用，试试 --port 其他端口");
            return;
        }
    };

    if let Ok(ip) = local_ip() {
        println!("  局域网地址: http://{}:{}", ip, cfg.port);
        println!("  在手机小程序里填这个地址 + 配对码 {}", cfg.token);
        println!();
    }

    let app = App {
        cfg: cfg.clone(),
        agents: Arc::new(Mutex::new(Vec::new())),
    };

    // 后台探测 Agent，不阻塞启动
    let app2 = app.clone();
    thread::spawn(move || {
        let list = detect_agents();
        println!("  已识别 Agent: {}", if list.is_empty() {
            "（无）".to_string()
        } else {
            list.iter().map(|a| format!("{} {}", a.name, a.version)).collect::<Vec<_>>().join(" / ")
        });
        println!();
        println!("  等待小程序连接…  (Ctrl+C 退出)");
        println!("==============================================");
        *app2.agents.lock().unwrap() = list;
    });

    for stream in listener.incoming() {
        match stream {
            Ok(s) => {
                let a = app.clone();
                thread::spawn(move || handle_conn(s, a));
            }
            Err(_) => continue,
        }
    }
}

fn print_help() {
    println!("快传 · 电脑控制端 v{}", VERSION);
    println!("  --port <端口>     默认 8765");
    println!("  --token <配对码>  默认随机 6 位");
    println!("  --cloud           云开发直连模式");
    println!("  --gw <url>        云函数网关模式（推荐）");
    println!("  --lan             监听 0.0.0.0，允许手机/局域网访问");
    println!("  --unsafe          不拦截危险命令");
}

fn gen_token() -> String {
    let seed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let pid = std::process::id() as u128;
    let mut v = seed ^ (pid << 32);
    let mut s = String::new();
    for _ in 0..6 {
        s.push(char::from(b'0' + (v % 10) as u8));
        v /= 10;
        v = v.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
    }
    s
}

fn local_ip() -> Result<String, ()> {
    // 不依赖外部 crate：连一个公网地址拿本机出口 IP（UDP 不实际发包）
    use std::net::UdpSocket;
    let sock = UdpSocket::bind("0.0.0.0:0").map_err(|_| ())?;
    sock.connect("8.8.8.8:80").map_err(|_| ())?;
    let ip = sock.local_addr().map_err(|_| ())?.ip().to_string();
    if ip.starts_with("127.") {
        return Err(());
    }
    Ok(ip)
}

// ---------------- HTTP ----------------

fn handle_conn(mut stream: TcpStream, app: App) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(30)));

    let mut buf = Vec::new();
    let mut tmp = [0u8; 4096];
    let mut header_end = 0usize;

    loop {
        match stream.read(&mut tmp) {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&tmp[..n]);
                if let Some(p) = find_sub(&buf, b"\r\n\r\n") {
                    header_end = p + 4;
                    break;
                }
                if buf.len() > 65536 {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    if header_end == 0 {
        return;
    }

    let head = String::from_utf8_lossy(&buf[..header_end]).to_string();
    let mut lines = head.split("\r\n");
    let first = lines.next().unwrap_or("");
    let mut parts = first.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let path_full = parts.next().unwrap_or("/").to_string();
    let path = path_full.split('?').next().unwrap_or("/").to_string();

    let mut content_len = 0usize;
    let mut token_hdr = String::new();
    let mut origin = String::new();
    let mut cookie = String::new();
    for l in lines {
        let lower = l.to_ascii_lowercase();
        if lower.starts_with("content-length:") {
            content_len = l[15..].trim().parse().unwrap_or(0);
        } else if lower.starts_with("x-kc-token:") {
            token_hdr = l[11..].trim().to_string();
        } else if lower.starts_with("origin:") {
            origin = l[7..].trim().to_string();
        } else if lower.starts_with("cookie:") {
            cookie = l[7..].trim().to_string();
        }
    }
    let _ = (origin, cookie);

    // 读 body
    let mut body = buf[header_end..].to_vec();
    while body.len() < content_len {
        match stream.read(&mut tmp) {
            Ok(0) => break,
            Ok(n) => body.extend_from_slice(&tmp[..n]),
            Err(_) => break,
        }
    }
    let body_str = String::from_utf8_lossy(&body).to_string();

    if method == "OPTIONS" {
        respond(&mut stream, 204, "", "text/plain");
        return;
    }

    let need_token = path != "/ping";
    if need_token && token_hdr != app.cfg.token {
        respond(&mut stream, 401, &format!("{{\"ok\":false,\"error\":\"token mismatch\",\"needToken\":true}}"), "application/json");
        return;
    }

    match (method.as_str(), path.as_str()) {
        ("GET", "/ping") => {
            let body = format!(
                "{{\"ok\":true,\"app\":\"kuaichuan\",\"version\":\"{}\",\"needToken\":true}}",
                VERSION
            );
            respond(&mut stream, 200, &body, "application/json");
        }
        ("GET", "/info") => {
            let agents = app.agents.lock().unwrap().clone();
            let body = format!(
                "{{\"ok\":true,\"host\":\"{}\",\"user\":\"{}\",\"os\":\"{}\",\"version\":\"{}\",\"agents\":{}}}",
                esc(&hostname()),
                esc(&username()),
                esc(&env::consts::OS),
                VERSION,
                agents_json(&agents)
            );
            respond(&mut stream, 200, &body, "application/json");
        }
        ("GET", "/agents") => {
            let agents = app.agents.lock().unwrap().clone();
            let body = format!("{{\"ok\":true,\"agents\":{}}}", agents_json(&agents));
            respond(&mut stream, 200, &body, "application/json");
        }
        ("POST", "/exec") => {
            let cmd = json_str(&body_str, "cmd").unwrap_or_default();
            if cmd.trim().is_empty() {
                respond(&mut stream, 400, "{\"ok\":false,\"error\":\"empty cmd\"}", "application/json");
                return;
            }
            if !app.cfg.unsafe_mode {
                if let Some(bad) = dangerous(&cmd) {
                    let body = format!("{{\"ok\":false,\"error\":\"命令被拦截: 命中危险模式 {}\",\"blocked\":true}}", esc(bad));
                    respond(&mut stream, 403, &body, "application/json");
                    return;
                }
            }
            let cwd = json_str(&body_str, "cwd").unwrap_or_default();
            let tmo = json_num(&body_str, "timeoutMs").unwrap_or(app.cfg.timeout_ms);
            let r = run_cmd(&cmd, &cwd, tmo);
            let body = format!(
                "{{\"ok\":true,\"cmd\":\"{}\",\"exitCode\":{},\"stdout\":\"{}\",\"stderr\":\"{}\",\"ms\":{},\"timedOut\":{}}}",
                esc(&cmd),
                r.exit_code,
                esc(&r.stdout),
                esc(&r.stderr),
                r.ms,
                r.timed_out
            );
            respond(&mut stream, 200, &body, "application/json");
        }
        ("POST", "/agent") => {
            // 本地直连的 agent 对话接口（不经云端，用于验证与局域网使用）
            let exe = json_str(&body_str, "exe")
                .or_else(|| json_str(&body_str, "agent"))
                .unwrap_or_default();
            let text = json_str(&body_str, "text").unwrap_or_default();
            if exe.trim().is_empty() || text.trim().is_empty() {
                respond(&mut stream, 400, "{\"ok\":false,\"error\":\"需要 exe 和 text\"}", "application/json");
                return;
            }

            let exe_lc = exe.to_lowercase();
            let args: Vec<String> = if exe_lc.contains("dsh") {
                vec!["--profile".into(), "headless".into(), text.clone()]
            } else if exe_lc.contains("codex") {
                vec!["exec".into(), "--skip-git-repo-check".into(), text.clone()]
            } else if exe_lc.contains("hermes") {
                vec!["-z".into(), text.clone()]
            } else {
                vec![text.clone()]
            };

            klog(&format!("    [本地 agent] {} {:?}", exe, args));
            let started = now_ms();
            match run_headless(&exe, &args, 180000) {
                Ok(raw) => {
                    let reply = strip_ansi(&raw);
                    let body = format!(
                        "{{\"ok\":true,\"agent\":\"{}\",\"reply\":\"{}\",\"ms\":{}}}",
                        esc(&exe), esc(reply.trim()), now_ms() - started
                    );
                    respond(&mut stream, 200, &body, "application/json");
                }
                Err(e) => {
                    let body = format!("{{\"ok\":false,\"error\":\"{}\"}}", esc(&e));
                    respond(&mut stream, 500, &body, "application/json");
                }
            }
        }
        _ => respond(&mut stream, 404, "{\"ok\":false,\"error\":\"not found\"}", "application/json"),
    }
}

fn respond(stream: &mut TcpStream, code: u16, body: &str, ctype: &str) {
    let reason = match code {
        200 => "OK",
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        501 => "Not Implemented",
        _ => "OK",
    };
    let resp = format!(
        "HTTP/1.1 {} {}\r\n\
         Content-Type: {}\r\n\
         Content-Length: {}\r\n\
         Access-Control-Allow-Origin: *\r\n\
         Access-Control-Allow-Headers: X-KC-Token, Content-Type\r\n\
         Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n\
         Access-Control-Allow-Private-Network: true\r\n\
         Connection: close\r\n\r\n{}",
        code,
        reason,
        ctype,
        body.as_bytes().len(),
        body
    );
    let _ = stream.write_all(resp.as_bytes());
    let _ = stream.flush();
}

fn find_sub(hay: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || hay.len() < needle.len() {
        return None;
    }
    (0..=hay.len() - needle.len()).find(|&i| &hay[i..i + needle.len()] == needle)
}

// ---------------- 命令执行 ----------------

struct RunResult {
    exit_code: i32,
    stdout: String,
    stderr: String,
    ms: u128,
    timed_out: bool,
}

fn run_cmd(cmd: &str, cwd: &str, timeout_ms: u64) -> RunResult {
    let start = Instant::now();
    // chcp 65001 让中文输出不乱码
    let full = format!("chcp 65001>nul && {}", cmd);

    let mut c = Command::new("cmd.exe");
    c.arg("/C").arg(&full);
    if !cwd.is_empty() && Path::new(cwd).is_dir() {
        c.current_dir(cwd);
    }
    c.stdout(Stdio::piped()).stderr(Stdio::piped()).stdin(Stdio::null());
    #[cfg(windows)]
    c.creation_flags(CREATE_NO_WINDOW);

    let mut child = match c.spawn() {
        Ok(ch) => ch,
        Err(e) => {
            return RunResult {
                exit_code: -1,
                stdout: String::new(),
                stderr: format!("启动失败: {}", e),
                ms: start.elapsed().as_millis(),
                timed_out: false,
            }
        }
    };

    let mut out = child.stdout.take().unwrap();
    let mut err = child.stderr.take().unwrap();
    let h1 = thread::spawn(move || {
        let mut b = Vec::new();
        let _ = out.read_to_end(&mut b);
        b
    });
    let h2 = thread::spawn(move || {
        let mut b = Vec::new();
        let _ = err.read_to_end(&mut b);
        b
    });

    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    let mut timed_out = false;
    let mut code = -1;
    loop {
        match child.try_wait() {
            Ok(Some(st)) => {
                code = st.code().unwrap_or(-1);
                break;
            }
            Ok(None) => {
                if Instant::now() > deadline {
                    timed_out = true;
                    let _ = child.kill();
                    let _ = child.wait();
                    code = -9;
                    break;
                }
                thread::sleep(Duration::from_millis(30));
            }
            Err(_) => break,
        }
    }

    let so = h1.join().unwrap_or_default();
    let se = h2.join().unwrap_or_default();

    let mut stdout = String::from_utf8_lossy(&so).to_string();
    let mut stderr = String::from_utf8_lossy(&se).to_string();
    if stdout.len() > MAX_OUT {
        stdout.truncate(MAX_OUT);
        stdout.push_str("\n…（输出过长已截断）");
    }
    if stderr.len() > MAX_OUT {
        stderr.truncate(MAX_OUT);
    }

    RunResult {
        exit_code: code,
        stdout,
        stderr,
        ms: start.elapsed().as_millis(),
        timed_out,
    }
}

fn dangerous(cmd: &str) -> Option<&'static str> {
    let c = cmd.to_lowercase();
    let pats = [
        "format c:", "format d:", "rm -rf /", "rm -rf /*", "del /f /s /q c:\\",
        "rd /s /q c:\\", "shutdown", "diskpart", "mkfs", "dd if=",
        "reg delete hklm", ":(){", "cipher /w", "bcdedit", "vssadmin delete",
    ];
    for p in pats {
        if c.contains(p) {
            return Some(p);
        }
    }
    None
}

// ---------------- Agent 探测 ----------------

const AGENTS: &[(&str, &[&str])] = &[
    ("Claude Code", &["claude.cmd", "claude.exe", "claude"]),
    ("Codex CLI", &["codex.cmd", "codex.exe", "codex"]),
    ("Hermes", &["hermes.cmd", "hermes.exe", "hermes"]),
    ("DeepSeek Harness (CLI)", &["dsh.cmd", "dsh.exe", "dsh"]),
    ("DeepSeek Harness (桌面版)", &["DeepSeek Harness.exe"]),
    ("Gemini CLI", &["gemini.cmd", "gemini.exe", "gemini"]),
    ("Aider", &["aider.cmd", "aider.exe", "aider"]),
    ("Ollama", &["ollama.exe", "ollama"]),
    ("Cursor CLI", &["cursor.cmd", "cursor.exe", "cursor"]),
];

// 搜索根目录：PATH + 常见安装位置（桌面应用不在 PATH 里）
fn search_roots() -> Vec<std::path::PathBuf> {
    let mut roots: Vec<std::path::PathBuf> = Vec::new();
    let path_var = env::var("Path").or_else(|_| env::var("PATH")).unwrap_or_default();
    for d in path_var.split(';') {
        if !d.trim().is_empty() {
            roots.push(std::path::PathBuf::from(d));
        }
    }
    let mut extra: Vec<String> = Vec::new();
    if let Ok(v) = env::var("LOCALAPPDATA") {
        extra.push(format!("{}\\Programs", v));
        extra.push(format!("{}\\hermes\\bin", v));
    }
    if let Ok(v) = env::var("APPDATA") {
        extra.push(format!("{}\\npm", v));
    }
    if let Ok(v) = env::var("ProgramFiles") {
        extra.push(v.clone());
    }
    for e in extra {
        let base = std::path::PathBuf::from(&e);
        if base.is_dir() {
            // 只在 Programs 这类目录下扫一层子目录，避免全盘遍历
            if let Ok(rd) = std::fs::read_dir(&base) {
                for ent in rd.flatten() {
                    let p = ent.path();
                    if p.is_dir() {
                        roots.push(p);
                    }
                }
            }
            roots.push(base);
        }
    }
    roots
}

// 桌面版 exe 不能跑 --version（会拉起 GUI），直接读文件版本信息
fn file_version(p: &Path) -> String {
    let ps = format!(
        "(Get-Item -LiteralPath '{}').VersionInfo.FileVersion",
        p.to_string_lossy().replace('\'', "''")
    );
    let mut c = Command::new("powershell.exe");
    c.args(["-NoProfile", "-NonInteractive", "-Command", &ps])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .stdin(Stdio::null());
    #[cfg(windows)]
    c.creation_flags(CREATE_NO_WINDOW);
    match c.output() {
        Ok(o) => {
            let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if s.is_empty() { String::from("(桌面版)") } else { s }
        }
        Err(_) => String::from("(桌面版)"),
    }
}

/// 单个智能体版本探测上限
const PROBE_TIMEOUT_MS: u64 = 6000;
/// 整轮探测总上限，超过就先返回已拿到的
const PROBE_TOTAL_MS: u64 = 7000;

fn detect_agents() -> Vec<AgentInfo> {
    let roots = search_roots();

    // 先定位所有命中，避免串行探测拖慢
    let mut jobs: Vec<(&'static str, String, std::path::PathBuf)> = Vec::new();
    for (name, candidates) in AGENTS {
        for cand in *candidates {
            let mut hit: Option<std::path::PathBuf> = None;
            for d in &roots {
                let p = d.join(cand);
                if p.is_file() {
                    hit = Some(p);
                    break;
                }
            }
            if let Some(p) = hit {
                jobs.push((
                    name,
                    cand.to_string(),
                    p,
                ));
                break;
            }
        }
    }

    // 并行探测版本：整体设一个截止时间，最慢的那个不许拖住启动
    let deadline = Instant::now() + Duration::from_millis(PROBE_TOTAL_MS);
    let mut handles = Vec::new();
    for (name, exe, path) in jobs {
        handles.push(thread::spawn(move || {
            let ver = if exe.to_lowercase().ends_with("harness.exe") {
                file_version(&path)
            } else {
                probe_version(&path)
            };
            AgentInfo {
                name: name.to_string(),
                exe: exe,
                path: path.to_string_lossy().to_string(),
                version: ver,
            }
        }));
    }

    let mut found: Vec<AgentInfo> = Vec::new();
    for h in handles {
        // 已经超过整体截止时间就跳过等待，迟到的结果下一轮重扫再补
        if Instant::now() >= deadline {
            continue;
        }
        if let Ok(a) = h.join() {
            found.push(a);
        }
    }
    found.sort_by(|a, b| a.name.cmp(&b.name));
    found
}

fn probe_version(p: &Path) -> String {
    let mut c = Command::new(p);
    c.arg("--version")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());
    #[cfg(windows)]
    c.creation_flags(CREATE_NO_WINDOW);
    match c.spawn() {
        Ok(mut ch) => {
            let start = Instant::now();
            let mut killed = false;
            loop {
                match ch.try_wait() {
                    Ok(Some(_)) => break,
                    Ok(None) => {
                        if start.elapsed() > Duration::from_millis(PROBE_TIMEOUT_MS) {
                            let _ = ch.kill();
                            killed = true;
                            break;
                        }
                        thread::sleep(Duration::from_millis(30));
                    }
                    Err(_) => break,
                }
            }
            if killed {
                // kill 之后必须回收，否则僵尸进程挂着、管道也不会关
                let _ = ch.wait();
                return String::from("(版本超时)");
            }
            let mut buf = Vec::new();
            if let Some(mut o) = ch.stdout.take() {
                let _ = o.read_to_end(&mut buf);
            }
            if buf.is_empty() {
                if let Some(mut e) = ch.stderr.take() {
                    let _ = e.read_to_end(&mut buf);
                }
            }
            let s = String::from_utf8_lossy(&buf).lines().next().unwrap_or("").trim().to_string();
            if s.is_empty() { String::from("(已安装)") } else { s }
        }
        Err(_) => String::from("(已安装)"),
    }
}
fn agents_json(list: &[AgentInfo]) -> String {
    let items: Vec<String> = list
        .iter()
        .map(|a| {
            format!(
                "{{\"name\":\"{}\",\"exe\":\"{}\",\"path\":\"{}\",\"version\":\"{}\"}}",
                esc(&a.name),
                esc(&a.exe),
                esc(&a.path),
                esc(&a.version)
            )
        })
        .collect();
    format!("[{}]", items.join(","))
}

// ---------------- 小工具 ----------------

fn hostname() -> String {
    env::var("COMPUTERNAME").unwrap_or_else(|_| "unknown".into())
}

fn username() -> String {
    env::var("USERNAME").unwrap_or_else(|_| "unknown".into())
}

fn esc(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 8);
    for ch in s.chars() {
        match ch {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            '\n' => o.push_str("\\n"),
            '\r' => o.push_str("\\r"),
            '\t' => o.push_str("\\t"),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
            c => o.push(c),
        }
    }
    o
}

// 极简 JSON 字段提取（够用即可，不是完整解析器）
fn json_str(body: &str, key: &str) -> Option<String> {
    let pat = format!("\"{}\"", key);
    let i = body.find(&pat)?;
    let rest = &body[i + pat.len()..];
    let colon = rest.find(':')?;
    let rest = rest[colon + 1..].trim_start();
    if !rest.starts_with('"') {
        return None;
    }
    let mut out = String::new();
    let mut chars = rest[1..].chars();
    while let Some(c) = chars.next() {
        match c {
            '"' => return Some(out),
            '\\' => match chars.next() {
                Some('n') => out.push('\n'),
                Some('r') => out.push('\r'),
                Some('t') => out.push('\t'),
                Some('"') => out.push('"'),
                Some('\\') => out.push('\\'),
                Some('u') => {
                    let hex: String = chars.by_ref().take(4).collect();
                    if let Ok(n) = u32::from_str_radix(&hex, 16) {
                        if let Some(ch) = char::from_u32(n) {
                            out.push(ch);
                        }
                    }
                }
                Some(o) => out.push(o),
                None => break,
            },
            c => out.push(c),
        }
    }
    None
}

fn json_num(body: &str, key: &str) -> Option<u64> {
    let pat = format!("\"{}\"", key);
    let i = body.find(&pat)?;
    let rest = &body[i + pat.len()..];
    let colon = rest.find(':')?;
    let rest = rest[colon + 1..].trim_start();
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse().ok()
}

// ---------------- 云模式（云开发中转）----------------

fn exe_dir() -> std::path::PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| std::path::PathBuf::from("."))
}

fn read_trim(path: &Path) -> Option<String> {
    std::fs::read_to_string(path)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

#[cfg(windows)]
fn no_window(c: &mut Command) {
    c.creation_flags(CREATE_NO_WINDOW);
}
#[cfg(not(windows))]
fn no_window(_c: &mut Command) {}

fn curl(method: &str, url: &str, key: &str, body: Option<&str>) -> Result<String, String> {
    let mut args: Vec<String> = vec![
        "-s".into(),
        "--max-time".into(),
        "25".into(),
        "-X".into(),
        method.into(),
        "-H".into(),
        format!("Authorization: Bearer {}", key),
        "-H".into(),
        "Content-Type: application/json".into(),
    ];
    let mut tmp: Option<std::path::PathBuf> = None;
    if let Some(b) = body {
        let p = std::env::temp_dir().join(format!("kc-body-{}.json", std::process::id()));
        std::fs::write(&p, b).map_err(|e| e.to_string())?;
        args.push("--data-binary".into());
        args.push(format!("@{}", p.to_string_lossy()));
        tmp = Some(p);
    }
    args.push(url.to_string());

    let mut c = Command::new("curl.exe");
    c.args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());
    no_window(&mut c);
    let out = c.output().map_err(|e| format!("调用 curl 失败: {}", e))?;
    if let Some(p) = tmp {
        let _ = std::fs::remove_file(p);
    }
    if !out.status.success() {
        return Err(format!(
            "curl 退出码 {:?}: {}",
            out.status.code(),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

fn urlencode(s: &str) -> String {
    let mut o = String::new();
    for b in s.as_bytes() {
        match *b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => o.push(*b as char),
            _ => o.push_str(&format!("%{:02X}", b)),
        }
    }
    o
}

fn list_objects(json: &str) -> Vec<String> {
    let mut out = Vec::new();
    let bytes = json.as_bytes();
    let lpos = match find_sub(bytes, b"\"list\"") {
        Some(p) => p,
        None => return out,
    };
    let mut i = lpos;
    while i < bytes.len() && bytes[i] != b'[' {
        i += 1;
    }
    let mut depth: i32 = 0;
    let mut start = 0usize;
    let mut in_str = false;
    let mut esc = false;
    let mut k = i;
    while k < bytes.len() {
        let c = bytes[k];
        if in_str {
            if esc {
                esc = false;
            } else if c == b'\\' {
                esc = true;
            } else if c == b'"' {
                in_str = false;
            }
        } else {
            match c {
                b'"' => in_str = true,
                b'{' => {
                    if depth == 0 {
                        start = k;
                    }
                    depth += 1;
                }
                b'}' => {
                    depth -= 1;
                    if depth == 0 {
                        out.push(json[start..=k].to_string());
                    }
                }
                b']' if depth == 0 => break,
                _ => {}
            }
        }
        k += 1;
    }
    out
}

fn doc_id(obj: &str) -> Option<String> {
    if let Some(s) = json_str(obj, "_id") {
        return Some(s);
    }
    json_str(obj, "$oid")
}

fn run_cloud(cfg: Config) {
    let dir = exe_dir();

    let key = if !cfg.api_key.is_empty() {
        cfg.api_key.clone()
    } else {
        read_trim(&dir.join(".cloudbase-apikey")).unwrap_or_default()
    };
    if key.is_empty() {
        eprintln!("找不到 API Key。");
        eprintln!("把 .cloudbase-apikey 放到 exe 同目录，或用 --apikey 传入。");
        return;
    }

    let code = if !cfg.device_code.is_empty() {
        cfg.device_code.clone()
    } else {
        read_trim(&dir.join(".device-code")).unwrap_or_else(gen_token)
    };
    let _ = std::fs::write(dir.join(".device-code"), &code);

    let base = format!(
        "https://{}.api.tcloudbasegateway.com/v1/database/instances/(default)/databases/(default)",
        cfg.env_id
    );

    println!("==============================================");
    println!("  快传 · 电脑控制端（云模式） v{}", VERSION);
    println!("==============================================");
    println!("  云环境   : {}", cfg.env_id);
    println!("  配对码   : {}", code);
    println!("  危险命令 : {}", if cfg.unsafe_mode { "不拦截（--unsafe）" } else { "拦截" });
    println!("  主机     : {} ({})", hostname(), username());
    println!();

    let agents = detect_agents();
    if agents.is_empty() {
        println!("  已识别 Agent: （无）");
    } else {
        println!(
            "  已识别 Agent: {}",
            agents
                .iter()
                .map(|a| format!("{} {}", a.name, a.version))
                .collect::<Vec<_>>()
                .join(" / ")
        );
    }
    println!();
    println!("  正在轮询云数据库…  (Ctrl+C 退出)");
    println!("==============================================");

    let cmd_coll = if cfg.project.is_empty() { String::from("commands") } else { format!("commands.{}", cfg.project) };
    let dev_coll = if cfg.project.is_empty() { String::from("devices") } else { format!("devices.{}", cfg.project) };

    let mut tick: u64 = 0;
    loop {
        // 心跳：每 8 轮（约 12 秒）写一次设备信息
        if tick % 8 == 0 {
            heartbeat(&base, &key, &code, &agents, &dev_coll);
        }
        tick += 1;

        let q = urlencode("{\"status\":\"pending\"}");
        let url = format!("{}/collections/{}/documents?query={}&limit=5", base, cmd_coll, q);
        match curl("GET", &url, &key, None) {
            Ok(body) => {
                let docs = list_objects(&body);
                for d in docs {
                    handle_command(&base, &key, &code, &cfg, &d, &cmd_coll);
                }
            }
            Err(e) => {
                println!("  ! 轮询失败: {}", e);
                thread::sleep(Duration::from_secs(3));
            }
        }
        thread::sleep(Duration::from_millis(1500));
    }
}

fn handle_command(base: &str, key: &str, code: &str, cfg: &Config, doc: &str, cmd_coll: &str) {
    let id = match doc_id(doc) {
        Some(s) => s,
        None => return,
    };
    let payload = json_str(doc, "payload").unwrap_or_default();
    let kind = json_str(doc, "kind").unwrap_or_else(|| "shell".to_string());
    if payload.trim().is_empty() {
        update_doc(
            base,
            key,
            cmd_coll,
            &id,
            "{\"status\":\"error\",\"stderr\":\"空命令\"}",
        );
        return;
    }
    if kind == "shell" && !cfg.unsafe_mode {
        if let Some(bad) = dangerous(&payload) {
            let msg = format!("命令被拦截: 命中危险模式 {}", bad);
            update_doc(
                base,
                key,
                cmd_coll,
                &id,
                &format!(
                    "{{\"status\":\"error\",\"stderr\":\"{}\",\"finishedAt\":{}}}",
                    esc(&msg),
                    now_ms()
                ),
            );
            println!("  ✗ 拦截 {}\n    {}", payload, msg);
            return;
        }
    }

    println!("  $ {}", payload);
    update_doc(
        base,
        key,
        cmd_coll,
        &id,
        &format!(
            "{{\"status\":\"running\",\"startedAt\":{},\"deviceCode\":\"{}\"}}",
            now_ms(),
            esc(code)
        ),
    );

    let r = run_cmd(&payload, "", cfg.timeout_ms);
    let status = if r.timed_out {
        "timeout"
    } else if r.exit_code == 0 {
        "done"
    } else {
        "error"
    };
    let first = r.stdout.lines().next().unwrap_or("");
    println!("    → {} (exit {} · {}ms) {}", status, r.exit_code, r.ms, first);

    let patch = format!(
        "{{\"status\":\"{}\",\"stdout\":\"{}\",\"stderr\":\"{}\",\"exitCode\":{},\"ms\":{},\"timedOut\":{},\"finishedAt\":{}}}",
        status,
        esc(&r.stdout),
        esc(&r.stderr),
        r.exit_code,
        r.ms,
        r.timed_out,
        now_ms()
    );
    update_doc(base, key, cmd_coll, &id, &patch);
}

// $set 更新一条命令文档
fn update_doc(base: &str, key: &str, coll: &str, id: &str, set_fields: &str) {
    let body = format!(
        "{{\"query\":{{\"_id\":\"{}\"}},\"data\":{{\"$set\":{}}}}}",
        esc(id),
        set_fields
    );
    let url = format!("{}/collections/{}/documents", base, coll);
    if let Err(e) = curl("PATCH", &url, key, Some(&body)) {
        println!("  ! 回写失败: {}", e);
    }
}

fn heartbeat(base: &str, key: &str, code: &str, agents: &[AgentInfo], dev_coll: &str) {
    let q = urlencode(&format!("{{\"deviceCode\":\"{}\"}}", code));
    let url = format!("{}/collections/{}/documents?query={}&limit=1", base, dev_coll, q);
    let body_common = format!(
        "\"deviceCode\":\"{}\",\"name\":\"{}\",\"lastSeen\":{},\"agents\":{}",
        esc(code),
        esc(&hostname()),
        now_ms(),
        agents_json(agents)
    );

    match curl("GET", &url, key, None) {
        Ok(resp) => {
            let docs = list_objects(&resp);
            if docs.is_empty() {
                let body = format!("{{\"data\":[{{{}}}]}}", body_common);
                let post_url = format!("{}/collections/{}/documents", base, dev_coll);
                if let Err(e) = curl("POST", &post_url, key, Some(&body)) {
                    println!("  ! 设备注册失败: {}", e);
                }
            } else if let Some(id) = doc_id(&docs[0]) {
                let body = format!(
                    "{{\"query\":{{\"_id\":\"{}\"}},\"data\":{{\"$set\":{{{}}}}}}}",
                    esc(&id),
                    body_common
                );
                let patch_url = format!("{}/collections/{}/documents", base, dev_coll);
                if let Err(e) = curl("PATCH", &patch_url, key, Some(&body)) {
                    println!("  ! 心跳失败: {}", e);
                }
            }
        }
        Err(e) => println!("  ! 心跳查询失败: {}", e),
    }
}

fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

// ---------------- 网关模式（云函数中继）----------------

fn gw_call(url: &str, key: &str, body: &str) -> Result<String, String> {
    let tmp = std::env::temp_dir().join(format!("kc-gw-{}.json", std::process::id()));
    std::fs::write(&tmp, body).map_err(|e| e.to_string())?;
    let mut c = Command::new("curl.exe");
    c.args([
        "-s", "--max-time", "25",
        "-X", "POST", url,
        "-H", &format!("Authorization: Bearer {}", key),
        "-H", "X-Tcb-Webfn: true",
        "-H", "Content-Type: application/json",
        "--data-binary", &format!("@{}", tmp.to_string_lossy()),
    ])
    .stdout(Stdio::piped()).stderr(Stdio::piped()).stdin(Stdio::null());
    no_window(&mut c);
    let out = c.output().map_err(|e| format!("curl 失败: {}", e))?;
    let _ = std::fs::remove_file(&tmp);
    if !out.status.success() {
        return Err(format!("curl 退出码 {:?}: {}", out.status.code(), String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

fn gw_json_url(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

fn run_gateway(cfg: Config) {
    let dir = exe_dir();
    let key = if !cfg.api_key.is_empty() {
        cfg.api_key.clone()
    } else {
        read_trim(&dir.join(".cloudbase-apikey")).unwrap_or_default()
    };
    if key.is_empty() {
        eprintln!("找不到 API Key：把 .cloudbase-apikey 放 exe 同目录，或用 --apikey 传入");
        return;
    }
    let code = if !cfg.device_code.is_empty() {
        cfg.device_code.clone()
    } else {
        read_trim(&dir.join(".device-code")).unwrap_or_else(gen_token)
    };
    let _ = std::fs::write(dir.join(".device-code"), &code);
    if cfg.gw_url.is_empty() {
        eprintln!("缺少网关地址，用法: kuaichuan.exe --gw https://xxx/v1/functions/kuaichuan-relay");
        return;
    }

    println!("==============================================");
    println!("  快传 · 电脑控制端（网关模式） v{}", VERSION);
    println!("==============================================");
    println!("  网关     : {}", cfg.gw_url);
    println!("  配对码   : {}", code);
    println!("  危险命令 : {}", if cfg.unsafe_mode { "不拦截（--unsafe）" } else { "拦截" });
    println!("  主机     : {} ({})", hostname(), username());

    let agents = detect_agents();
    println!("  已识别 Agent: {}", if agents.is_empty() { "（无）".to_string() } else {
        agents.iter().map(|a| format!("{} {}", a.name, a.version)).collect::<Vec<_>>().join(" / ")
    });
    println!();

    // 自检
    match gw_call(&cfg.gw_url, &key, "{\"action\":\"ping\"}") {
        Ok(r) => println!("  网关自检 : {}", r.trim()),
        Err(e) => println!("  网关自检失败: {}", e),
    }
    println!();
    println!("  正在轮询云端…  (Ctrl+C 退出)");
    println!("==============================================");

    let mut hb_agents = agents_json(&agents);
    let mut tick: u64 = 0;
    let mut last_term_seq: u64 = 0;
    loop {
        if tick % 8 == 0 {
            // 每分钟重扫一次，保证版本号不会停在启动那一刻
            if tick % 40 == 0 {
                let fresh = detect_agents();
                hb_agents = agents_json(&fresh);
                println!("  [扫描] 已重新识别 {} 个智能体", fresh.len());
            }
            let body = format!(
                "{{\"action\":\"heartbeat\",\"deviceCode\":\"{}\",\"name\":\"{}\",\"agents\":{}}}",
                esc(&code), esc(&hostname()), hb_agents
            );
            if let Err(e) = gw_call(&cfg.gw_url, &key, &body) {
                println!("  ! 心跳失败: {}", e);
            }
        }
        tick += 1;

        let body = "{\"action\":\"poll\",\"limit\":5}";
        match gw_call(&cfg.gw_url, &key, body) {
            Ok(resp) => {
                for d in list_objects(&resp) {
                    gw_handle(&cfg.gw_url, &key, &code, &cfg, &d);
                }
            }
            Err(e) => {
                println!("  ! 轮询失败: {}", e);
                thread::sleep(Duration::from_secs(3));
            }
        }
        // ---- 终端：检查 shell 是否被手机切换 ----
        if tick % 5 == 0 {
            let q = format!("{{\"action\":\"term_shell_get\",\"deviceCode\":\"{}\"}}", esc(&code));
            if let Ok(resp) = gw_call(&cfg.gw_url, &key, &q) {
                let parsed = json_str(&resp, "shell");
                let cur = TERM_SHELL.lock().ok().and_then(|q| q.clone());
                klog(&format!("    [轮询] shell 原始响应={}  解析={:?}  当前={:?}", resp, parsed, cur));
                if let Some(sh) = parsed {
                    match cur.as_deref() {
                        // 首次读到云端值：只记住，绝不重置。
                        // 否则如果手机已经抢先敲了命令（比如 claude），
                        // 这次重置会把正在启动的程序直接杀掉。
                        None => {
                            klog(&format!("    [终端] 采用云端 shell = {}（首次）", sh));
                            if let Ok(mut g) = TERM_SHELL.lock() {
                                *g = Some(sh.clone());
                            }
                            // 会话可能已经用默认 shell 建好了，这里要核实一次。
                            // 之前只记值不重建，结果选了 PowerShell 还是 Git Bash。
                            if let Ok(guard) = TERM.lock() {
                                if guard.is_some() {
                                    let started = CUR_SHELL.lock().ok().and_then(|q| q.clone());
                                    if started.as_deref() != Some(sh.as_str()) {
                                        klog(&format!(
                                            "    [终端] 会话 shell 不符（当前 {:?}），重建",
                                            started
                                        ));
                                        drop(guard);
                                        term_reset();
                                    }
                                }
                            }
                        }
                        Some(c) if c != sh.as_str() => {
                            klog(&format!("    [终端] 切换 shell -> {} (原 {})", sh, c));
                            if let Ok(mut g) = TERM_SHELL.lock() {
                                *g = Some(sh);
                            }
                            term_reset();
                            // 立刻用新 shell 重建；不建的话会一直等第一个按键才启动
                            let _ = ensure_term();
                        }
                        _ => {}
                    }
                }
                // 手机端「重新打开终端」会更新 restartAt，变化就重建一个干净会话
                if let Some(ra) = json_num(&resp, "restartAt") {
                    if ra > 0 {
                        let mut last = LAST_RESTART.lock().unwrap_or_else(|e| e.into_inner());
                        if *last != ra {
                            let first = *last == 0;
                            *last = ra;
                            if !first {
                                klog("    [终端] 收到重启请求，重建会话");
                                term_reset();
                                // 重置后必须立刻重建，否则要等第一个按键才会起 shell
                                let _ = ensure_term();
                                // 推一个空帧，让手机端立刻清屏（否则会停在旧画面上）
                                let body = format!(
                                    "{{\"action\":\"term_push\",\"deviceCode\":\"{}\",\"seq\":{},\"text\":\"\"}}",
                                    esc(&code),
                                    now_ms()
                                );
                                let _ = gw_call(&cfg.gw_url, &key, &body);
                            }
                        }
                    }
                }
            }
        }

        // ---- Agent：拉取待发送的消息 ----
        if let Ok(resp) = gw_call(&cfg.gw_url, &key, "{\"action\":\"agent_in\"}") {
            for d in list_objects(&resp) {
                let id = match doc_id(&d) { Some(x) => x, None => continue };
                let text = json_str(&d, "text").unwrap_or_default();
                let agent = json_str(&d, "agent").unwrap_or_else(|| "claude".to_string());
                let exe = json_str(&d, "exe").unwrap_or_else(|| agent.clone());
                if text.trim().is_empty() { continue; }

                klog(&format!("    [agent] 收到消息 -> {}", agent));
                // headless 模式：agent 支持「单次提问 → 纯文本输出」，比 PTY 可靠得多
                let headless = json_str(&d, "headless").unwrap_or_default();
                if headless == "1" {
                    let exe_lc = exe.to_lowercase();
                    let args: Vec<String> = if exe_lc.contains("dsh") {
                        // headless 是 profile 名，必须写成 --profile headless <任务>
                        vec!["--profile".into(), "headless".into(), text.clone()]
                    } else if exe_lc.contains("codex") {
                        vec!["exec".into(), "--skip-git-repo-check".into(), text.clone()]
                    } else if exe_lc.contains("hermes") {
                        vec!["-z".into(), text.clone()]
                    } else {
                        vec![text.clone()]
                    };
                    klog(&format!("    [agent] headless: {} {:?}", exe, args));
                    let out = run_headless(&exe, &args, 120000);
                    let reply = match out {
                        Ok(s) => {
                            let c = strip_ansi(&s);
                            if c.trim().is_empty() { "（没有输出）".to_string() } else { c }
                        }
                        Err(e) => format!("（执行失败：{}）", e),
                    };
                    let body = format!(
                        "{{\"action\":\"agent_reply\",\"deviceCode\":\"{}\",\"id\":\"{}\",\"text\":\"{}\"}}",
                        esc(&code), gw_json_url(&id), esc(&reply)
                    );
                    let _ = gw_call(&cfg.gw_url, &key, &body);
                    continue;
                }

                let mut reply;
                match agent_ensure(&agent, &exe) {
                    Ok(_) => match agent_ask(&text, 90000) {
                        Ok(raw) => reply = strip_ansi(&raw),
                        Err(e) => reply = format!("（{}）", e),
                    },
                    Err(e) => reply = format!("（启动 {} 失败：{}）", agent, e),
                }
                if reply.trim().is_empty() {
                    reply = "（没有输出）".to_string();
                }

                let body = format!(
                    "{{\"action\":\"agent_reply\",\"deviceCode\":\"{}\",\"id\":\"{}\",\"text\":\"{}\"}}",
                    esc(&code), gw_json_url(&id), esc(&reply)
                );
                if let Err(e) = gw_call(&cfg.gw_url, &key, &body) {
                    klog(&format!("    [agent] 回复失败: {}", e));
                }
            }
        }

        // ---- 终端：拉取手机端按键 ----
        if let Ok(resp) = gw_call(&cfg.gw_url, &key, "{\"action\":\"term_in\"}") {
            for d in list_objects(&resp) {
                let id = match doc_id(&d) { Some(x) => x, None => continue };
                let data = json_str(&d, "data").unwrap_or_default();
                if data.is_empty() { continue; }
                if ensure_term().is_ok() && term_write(&data).is_ok() {
                    let ack = format!("{{\"action\":\"term_ack\",\"id\":\"{}\"}}", gw_json_url(&id));
                    let _ = gw_call(&cfg.gw_url, &key, &ack);
                }
            }
        }
        // ---- 终端：推送新输出 ----
        if tick % 2 == 0 {
            let (cur, chunk) = term_drain(last_term_seq);
            if !chunk.is_empty() {
                last_term_seq = cur;
                let body = format!(
                    "{{\"action\":\"term_push\",\"deviceCode\":\"{}\",\"seq\":{},\"text\":\"{}\"}}",
                    esc(&code), cur, esc(&chunk)
                );
                if let Err(e) = gw_call(&cfg.gw_url, &key, &body) {
                    println!("  ! 终端输出推送失败: {}", e);
                }
            } else {
                last_term_seq = cur;
            }
        }

        thread::sleep(Duration::from_millis(1200));
    }
}

fn gw_update(url: &str, key: &str, id: &str, set_fields: &str) {
    let body = format!(
        "{{\"action\":\"update\",\"id\":\"{}\",\"patch\":{}}}",
        gw_json_url(id), set_fields
    );
    if let Err(e) = gw_call(url, key, &body) {
        println!("  ! 回写失败: {}", e);
    }
}

fn gw_handle(url: &str, key: &str, code: &str, cfg: &Config, doc: &str) {
    let id = match doc_id(doc) { Some(s) => s, None => return };
    let payload = json_str(doc, "payload").unwrap_or_default();
    let kind = json_str(doc, "kind").unwrap_or_else(|| "shell".to_string());
    if payload.trim().is_empty() {
        gw_update(url, key, &id, "{\"status\":\"error\",\"stderr\":\"空命令\"}");
        return;
    }
    if kind == "shell" && !cfg.unsafe_mode {
        if let Some(bad) = dangerous(&payload) {
            let msg = format!("命令被拦截: 命中危险模式 {}", bad);
            gw_update(url, key, &id, &format!(
                "{{\"status\":\"error\",\"stderr\":\"{}\",\"finishedAt\":{}}}", esc(&msg), now_ms()));
            println!("  ✗ 拦截 {}\n    {}", payload, msg);
            return;
        }
    }

    println!("  $ {}", payload);
    gw_update(url, key, &id, &format!(
        "{{\"status\":\"running\",\"startedAt\":{},\"deviceCode\":\"{}\"}}", now_ms(), esc(code)));

    // 处理 cd：切换会话工作目录，不真的执行
    let trimmed = payload.trim();
    if let Some(rest) = trimmed.strip_prefix("cd ") {
        let mut target = rest.trim().trim_matches(char::from(34));
        // 兼容 cd /d X: 这种写法
        if target.to_lowercase().starts_with("/d ") {
            target = target[3..].trim();
        }
        let base = get_cwd();
        let candidate = if target.is_empty() {
            env::var("USERPROFILE").unwrap_or_else(|_| "C:\\\\".to_string())
        } else if Path::new(target).is_absolute() {
            target.to_string()
        } else if base.is_empty() {
            target.to_string()
        } else {
            format!("{}\\{}", base, target)
        };
        let out = if Path::new(&candidate).is_dir() {
            set_cwd(&candidate);
            format!("切换到 {}", candidate)
        } else {
            format!("目录不存在: {}", candidate)
        };
        println!("    → cd: {}", out);
        let set = format!(
            "{{\"status\":\"done\",\"stdout\":\"{}\",\"stderr\":\"\",\"exitCode\":0,\"ms\":0,\"timedOut\":false,\"finishedAt\":{}}}",
            esc(&out), now_ms());
        gw_update(url, key, &id, &set);
        return;
    }

    let r = run_cmd(&payload, &get_cwd(), cfg.timeout_ms);
    let status = if r.timed_out { "timeout" } else if r.exit_code == 0 { "done" } else { "error" };
    println!("    → {} (exit {} · {}ms) {}", status, r.exit_code, r.ms, r.stdout.lines().next().unwrap_or(""));

    let set = format!(
        "{{\"status\":\"{}\",\"stdout\":\"{}\",\"stderr\":\"{}\",\"exitCode\":{},\"ms\":{},\"timedOut\":{},\"finishedAt\":{}}}",
        status, esc(&r.stdout), esc(&r.stderr), r.exit_code, r.ms, r.timed_out, now_ms());
    gw_update(url, key, &id, &set);
}

// ---------------- 常驻终端会话（Git Bash）----------------

struct TermSession {
    writer: Box<dyn std::io::Write + Send>,
    buf: std::sync::Arc<Mutex<Vec<(u64, String)>>>,
    seq: std::sync::Arc<Mutex<u64>>,
}

static TERM: Mutex<Option<TermSession>> = Mutex::new(None);
static TERM_PC: Mutex<Option<isize>> = Mutex::new(None);

fn bash_path() -> String {
    let cands = [
        r"C:\Program Files\Git\bin\bash.exe",
        r"C:\Program Files (x86)\Git\bin\bash.exe",
        r"C:\Program Files\Git\usr\bin\bash.exe",
    ];
    for c in cands {
        if Path::new(c).is_file() {
            return c.to_string();
        }
    }
    String::from("bash.exe")
}

fn push_chunk(buf: &std::sync::Arc<Mutex<Vec<(u64, String)>>>, seq: &std::sync::Arc<Mutex<u64>>, text: String) {
    if let (Ok(mut q), Ok(mut bb)) = (seq.lock(), buf.lock()) {
        *q = now_ms() as u64;
        bb.push((*q, text));
        if bb.len() > 800 {
            bb.remove(0);
        }
    }
}

// 默认：管道版 bash（无 TTY，但普通命令都能跑）
fn ensure_term() -> Result<(), String> {
    let mut g = TERM.lock().map_err(|_| "term lock")?;
    if g.is_some() {
        return Ok(());
    }

    let use_pty = env::var("KC_PTY").map(|v| v != "0").unwrap_or(true);

    let buf: std::sync::Arc<Mutex<Vec<(u64, String)>>> = std::sync::Arc::new(Mutex::new(Vec::new()));
    let seq: std::sync::Arc<Mutex<u64>> = std::sync::Arc::new(Mutex::new(0));

    if use_pty {
        #[cfg(windows)]
        {
            let which = TERM_SHELL.lock().ok().and_then(|q| q.clone()).unwrap_or_else(|| String::from("gitbash"));
            let cmdline = match which.as_str() {
                "cmd" => String::from("cmd.exe /K"),
                "powershell" => String::from("powershell.exe -NoLogo"),
                _ => format!("\"{}\" --norc --noprofile -i", bash_path()),
            };
            klog(&format!("    [终端] 启动 shell = {}", cmdline));
            if let Ok(mut c) = CUR_SHELL.lock() {
                *c = Some(which.clone());
            }
            let p = match pty::spawn(&cmdline, 120, 40) {
                Ok(p) => p,
                Err(e) => {
                    klog(&format!("    [pty] 创建失败，回退管道: {}", e));
                    drop(g);
                    std::env::set_var("KC_PTY", "0");
                    return ensure_term();
                }
            };

            let mut reader = p.reader;
            let b = buf.clone();
            let s = seq.clone();
            // 本会话的世代号：旧会话的线程即使还活着，也不会再污染屏幕
            let my_gen = {
                let mut g2 = SCREEN_GEN.lock().unwrap_or_else(|e| e.into_inner());
                *g2 += 1;
                *g2
            };
            thread::spawn(move || {
                let mut tmp = [0u8; 4096];
                loop {
                    match reader.read(&mut tmp) {
                        Ok(0) => { klog("    [pty] 读取结束: EOF"); break; }
                        Ok(n) => {

                            let raw = String::from_utf8_lossy(&tmp[..n]).to_string();
                            // 先灌进屏幕网格，只有画面变化时推整屏快照
                            if let Some(snap) = vt_feed(my_gen, &raw) {
                                push_chunk(&b, &s, snap);
                            }
                        }
                        Err(e) => { klog(&format!("    [pty] 读取错误: {}", e)); break; }
                    }
                }
            });
            *g = Some(TermSession { writer: Box::new(p.writer), buf, seq });
            klog(&format!("    [终端] ConPTY 会话已建立 (pid {})", p.pid));
            return Ok(());
        }
        #[cfg(not(windows))]
        return Err("ConPTY 仅支持 Windows".into());
    }

    let mut c = Command::new(bash_path());
    c.args(["--norc", "--noprofile", "-i"]);
    c.env("PS1", "$ ");
    c.env("TERM", "dumb");
    c.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    c.creation_flags(CREATE_NO_WINDOW);
    let mut child = c.spawn().map_err(|e| format!("启动 bash 失败: {}", e))?;
    let stdin = child.stdin.take().ok_or("no stdin")?;
    let out = child.stdout.take().ok_or("no stdout")?;
    let err = child.stderr.take();

    let b1 = buf.clone();
    let s1 = seq.clone();
    let mut o = out;
    thread::spawn(move || {
        let mut tmp = [0u8; 4096];
        loop {
            match o.read(&mut tmp) {
                Ok(0) => break,
                Ok(n) => push_chunk(&b1, &s1, String::from_utf8_lossy(&tmp[..n]).to_string()),
                Err(_) => break,
            }
        }
    });

    if let Some(mut e) = err {
        let b2 = buf.clone();
        let s2 = seq.clone();
        thread::spawn(move || {
            let mut tmp = [0u8; 4096];
            loop {
                match e.read(&mut tmp) {
                    Ok(0) => break,
                    Ok(n) => push_chunk(&b2, &s2, String::from_utf8_lossy(&tmp[..n]).to_string()),
                    Err(_) => break,
                }
            }
        });
    }

    *g = Some(TermSession { writer: Box::new(stdin), buf, seq });
    println!("    [终端] bash 管道会话已建立（无 TTY）");
    Ok(())
}

/// 关闭当前会话，下次 ensure_term 会用 TERM_SHELL 里记着的 shell 重建。
/// 注意：这里【不能】清 TERM_SHELL，否则轮询会一直判定「云端设置 != 当前」而无限重置。
fn term_reset() {
    if let Ok(mut g) = TERM.lock() {
        *g = None;
    }
    if let Ok(mut s) = SCREEN.lock() {
        *s = None;
    }
    if let Ok(mut c) = CUR_SHELL.lock() {
        *c = None;
    }
    klog("    [终端] 会话已重置");
}

static LAST_RESTART: Mutex<u64> = Mutex::new(0);

/// 从简单 JSON 里取一个数字字段（值可能是 {"$numberLong":"..."} 形式）

static TERM_SHELL: Mutex<Option<String>> = Mutex::new(None);
// 会话实际用的 shell（TERM_SHELL 是「想要的」，这个是「实际起的」）
static CUR_SHELL: Mutex<Option<String>> = Mutex::new(None);

/// 把控制字符翻译成 win32 按键序列。
/// ConPTY 的输入管道里直接写 0x03 只会变成一个普通字符，
/// 程序收不到 Ctrl+C 中断；必须按 ?9001h（win32 输入模式）的格式发按键事件。
fn translate_keys(data: &str) -> Vec<u8> {
    let mut out: Vec<u8> = Vec::with_capacity(data.len());
    let mut changed = false;
    for ch in data.chars() {
        match ch {
            // Ctrl+C：Vk=0x43('C'), Sc=0x2E, Uc=0x03, 按下, 左Ctrl, 重复 1 次
            '\u{3}' => {
                out.extend_from_slice(b"\x1b[67;46;3;1;8;1_");
                changed = true;
            }
            // Ctrl+D
            '\u{4}' => {
                out.extend_from_slice(b"\x1b[68;32;4;1;8;1_");
                changed = true;
            }
            // Esc
            '\u{1b}' => {
                out.extend_from_slice(b"\x1b[27;1;27;1;0;1_");
                changed = true;
            }
            _ => {
                let mut buf = [0u8; 4];
                out.extend_from_slice(ch.encode_utf8(&mut buf).as_bytes());
            }
        }
    }
    if changed {
        klog(&format!("    [pty] 按键翻译: {:?} -> {} 字节", data, out.len()));
    }
    out
}

fn term_write(data: &str) -> Result<(), String> {
    let bytes = translate_keys(data);
    let mut g = TERM.lock().map_err(|_| "term lock")?;
    let s = g.as_mut().ok_or("no session")?;
    match s.writer.write_all(&bytes) {
        Ok(_) => {}
        Err(e) => {
            klog(&format!("    [pty] 写入失败: {}", e));
            return Err(e.to_string());
        }
    }
    let _ = s.writer.flush();
    Ok(())
}
// 取出 since 之后的**最新一帧**整屏快照。
// 注意：不能把多帧拼起来——每帧都是完整屏幕，拼接会造成画面重复。
/// 在 PATH 和 npm 全局目录里找一个可执行文件
fn which_exe(name: &str) -> Option<String> {
    if Path::new(name).is_file() {
        return Some(name.to_string());
    }
    let mut dirs: Vec<String> = Vec::new();
    if let Ok(p) = env::var("PATH") {
        for d in p.split(';') {
            if !d.is_empty() { dirs.push(d.to_string()); }
        }
    }
    for k in ["APPDATA", "LOCALAPPDATA"] {
        if let Ok(v) = env::var(k) {
            dirs.push(format!("{}\\npm", v));
            dirs.push(format!("{}\\Programs", v));
        }
    }
    for d in dirs {
        let cand = Path::new(&d).join(name);
        if cand.is_file() {
            return Some(cand.to_string_lossy().to_string());
        }
    }
    None
}
/// 从 npm 生成的 xxx.cmd 里解析出真正的 JS 入口
fn npm_cmd_entry(cmd_path: &str) -> Option<String> {
    let txt = std::fs::read_to_string(cmd_path).ok()?;
    for line in txt.lines() {
        // 形如: ... "%_prog%"  "%dp0%\node_modules\@scope\pkg\lib\bin.js" %*
        if let Some(i) = line.find("node_modules\\") {
            if let Some(start) = line[i..].find("node_modules\\") {
                let rest = &line[i + start..];
                if let Some(end) = rest.find(".js") {
                    let rel = &rest[..end + 3];
                    let dir = Path::new(cmd_path).parent()?;
                    let full = dir.join(rel.replace('\\', "\\"));
                    if full.is_file() {
                        return Some(full.to_string_lossy().to_string());
                    }
                }
            }
        }
    }
    None
}

/// npm 目录旁通常有个 node.exe，优先用它
fn node_near(cmd_path: &str) -> Option<String> {
    let dir = Path::new(cmd_path).parent()?;
    let cand = dir.join("node.exe");
    if cand.is_file() {
        return Some(cand.to_string_lossy().to_string());
    }
    which_exe("node.exe")
}
/// 直接跑一个进程并拿到它的 stdout（非交互模式，用于 headless agent）
fn run_headless(exe: &str, args: &[String], timeout_ms: u64) -> Result<String, String> {
    // .cmd 批处理经 cmd.exe 启动时会踩引号与权限的坑。
    // npm 生成的 xxx.cmd 本质是 `node "…\lib\bin.js" %*`，
    // 这里解析出 bin.js 直接用 node 调用，绕开中间层。
    let mut cmd_exe = exe.to_string();
    let mut pre: Vec<String> = Vec::new();
    let lc = exe.to_lowercase();

    if lc.ends_with(".cmd") || lc.ends_with(".bat") {
        if let Some(bin_js) = npm_cmd_entry(exe) {
            let node = node_near(exe).unwrap_or_else(|| "node".to_string());
            cmd_exe = node;
            pre.push(bin_js);
        } else {
            cmd_exe = "cmd.exe".to_string();
        }
    }

    let mut c = Command::new(&cmd_exe);
    if cmd_exe.eq_ignore_ascii_case("cmd.exe") {
        c.arg("/c").arg(exe);
    }
    for p in pre { c.arg(p); }
    c.args(args);
    c.stdin(Stdio::null());
    c.stdout(Stdio::piped()).stderr(Stdio::piped());
    // 不额外注入 HOME/USERPROFILE：DSH 等程序会据此改写自身配置
    #[cfg(windows)]
    c.creation_flags(CREATE_NO_WINDOW);

    let mut child = c.spawn().map_err(|e| format!("启动失败: {}", e))?;

    // 必须边跑边读：管道缓冲写满会让子进程阻塞，永远等不到退出
    let mut out_pipe = child.stdout.take();
    let mut err_pipe = child.stderr.take();
    let collected: std::sync::Arc<Mutex<(Vec<u8>, Vec<u8>)>> =
        std::sync::Arc::new(Mutex::new((Vec::new(), Vec::new())));

    let c1 = collected.clone();
    let h1 = out_pipe.take().map(|mut p| {
        thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match p.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => { if let Ok(mut g) = c1.lock() { g.0.extend_from_slice(&buf[..n]); } }
                    Err(_) => break,
                }
            }
        })
    });
    let c2 = collected.clone();
    let h2 = err_pipe.take().map(|mut p| {
        thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match p.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => { if let Ok(mut g) = c2.lock() { g.1.extend_from_slice(&buf[..n]); } }
                    Err(_) => break,
                }
            }
        })
    });

    let start = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if start.elapsed() > Duration::from_millis(timeout_ms) {
                    let _ = child.kill();
                    return Err("超时".into());
                }
                thread::sleep(Duration::from_millis(120));
            }
            Err(e) => return Err(format!("等待失败: {}", e)),
        }
    }
    if let Some(h) = h1 { let _ = h.join(); }
    if let Some(h) = h2 { let _ = h.join(); }

    let g = collected.lock().map_err(|_| "读取失败")?;
    let mut s = String::from_utf8_lossy(&g.0).to_string();
    if s.trim().is_empty() {
        s = String::from_utf8_lossy(&g.1).to_string();
    }
    Ok(s)
}
/// 去掉 ANSI 控制序列，只留可读文字
fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let b: Vec<char> = s.chars().collect();
    let mut i = 0usize;
    while i < b.len() {
        if b[i] == '\u{1b}' {
            if i + 1 < b.len() && b[i + 1] == '[' {
                let mut j = i + 2;
                while j < b.len() && !(('\u{40}'..='\u{7e}').contains(&b[j])) {
                    j += 1;
                }
                i = j + 1;
                continue;
            } else if i + 1 < b.len() && b[i + 1] == ']' {
                let mut j = i + 2;
                while j < b.len() && b[j] != '\u{7}' {
                    j += 1;
                }
                i = j + 1;
                continue;
            }
            i += 2;
            continue;
        }
        // 保留空格；只丢掉 ESC 序列和控制字符
        if (b[i] as u32) < 0x20 && b[i] != '\n' && b[i] != '\t' {
            i += 1;
            continue;
        }
        out.push(b[i]);
        i += 1;
    }
    // 合并多余空行
    let mut res = String::new();
    let mut blank = 0;
    for line in out.split('\n') {
        let l = line.trim_end();
        if l.trim().is_empty() {
            blank += 1;
            if blank > 1 { continue; }
        } else {
            blank = 0;
        }
        res.push_str(l);
        res.push('\n');
    }
    res.trim().to_string()
}
// ---------------- 常驻 agent 会话（交互式对话）----------------
// 和终端不同：这里是「一问一答」模式，把用户输入写给 agent 的 stdin，
// 收集它的输出直到安静下来，再整段回给手机。

struct AgentSession {
    writer: Box<dyn std::io::Write + Send>,
    out: std::sync::Arc<Mutex<Vec<u8>>>,
    name: String,
}

static AGENT: Mutex<Option<AgentSession>> = Mutex::new(None);
static AGENT_GEN: Mutex<u64> = Mutex::new(0);

fn agent_reset() {
    if let Ok(mut g) = AGENT.lock() {
        *g = None;
    }
    klog("    [agent] 会话已重置");
}

/// 起一个常驻 agent；name 是智能体可执行文件名
fn agent_ensure(name: &str, exe: &str) -> Result<(), String> {
    let mut g = AGENT.lock().map_err(|_| "agent lock")?;
    if let Some(s) = g.as_ref() {
        if s.name == name {
            return Ok(());
        }
    }
    *g = None; // 换智能体：丢掉旧的

    #[cfg(windows)]
    {
        // 兜底：裸命令名补上扩展名，否则 CreateProcessW 会报 183
        let mut real = exe.to_string();
        if !real.contains('\\') && !real.contains('/') && !real.to_lowercase().ends_with(".exe")
            && !real.to_lowercase().ends_with(".cmd") && !real.to_lowercase().ends_with(".bat") {
            let cands = [
                format!("{}.cmd", real),
                format!("{}.exe", real),
                format!("{}.bat", real),
            ];
            for c in cands.iter() {
                if which_exe(c).is_some() { real = which_exe(c).unwrap(); break; }
            }
        }
        // 直接传 .cmd 给 ConPTY 即可；套 cmd /C 会在命令结束后立刻退出，没法持续对话
        let cmdline = format!("\"{}\"", real);
        klog(&format!("    [agent] 启动 {}", cmdline));
        let p = match pty::spawn(&cmdline, 120, 40) {
            Ok(p) => p,
            Err(e) => return Err(format!("启动失败: {}", e)),
        };

        let out: std::sync::Arc<Mutex<Vec<u8>>> = std::sync::Arc::new(Mutex::new(Vec::new()));
        let o2 = out.clone();
        let mut reader = p.reader;
        thread::spawn(move || {
            let mut tmp = [0u8; 4096];
            loop {
                match reader.read(&mut tmp) {
                    Ok(0) => break,
                    Ok(n) => {
                        if let Ok(mut b) = o2.lock() {
                            b.extend_from_slice(&tmp[..n]);
                            // 只留最近 256KB，防止无限增长
                            if b.len() > 256 * 1024 {
                                let cut = b.len() - 256 * 1024;
                                b.drain(0..cut);
                            }
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        *g = Some(AgentSession {
            writer: Box::new(p.writer),
            out: out,
            name: name.to_string(),
        });
        Ok(())
    }
    #[cfg(not(windows))]
    Err("仅支持 Windows".into())
}

/// 把一段用户输入发给 agent，等它输出安静下来后返回新增的文字
fn agent_ask(text: &str, wait_ms: u64) -> Result<String, String> {
    let out;
    let before;
    {
        let g = AGENT.lock().map_err(|_| "agent lock")?;
        let s = g.as_ref().ok_or("没有活跃的 agent 会话")?;
        out = s.out.clone();
        before = s.out.lock().map(|b| b.len()).unwrap_or(0);
    }

    // 写入单独加锁，避免持锁等待
    {
        let mut g = AGENT.lock().map_err(|_| "agent lock")?;
        let s = g.as_mut().ok_or("没有活跃的 agent 会话")?;
        s.writer
            .write_all(text.as_bytes())
            .and_then(|_| s.writer.write_all(b"\r"))
            .and_then(|_| s.writer.flush())
            .map_err(|e| format!("写入失败: {}", e))?;
    }

    // 等输出稳定：连续 700ms 没有新内容就认为说完了
    let start = std::time::Instant::now();
    let mut last_len = before;
    let mut stable = std::time::Instant::now();
    loop {
        thread::sleep(Duration::from_millis(120));
        let now_len = out.lock().map(|b| b.len()).unwrap_or(0);
        if now_len != last_len {
            last_len = now_len;
            stable = std::time::Instant::now();
        } else if stable.elapsed() > Duration::from_millis(700) {
            break;
        }
        if start.elapsed() > Duration::from_millis(wait_ms) {
            break;
        }
    }

    let buf = out.lock().map_err(|_| "读输出失败")?;
    if buf.len() <= before {
        return Ok(String::new());
    }
    let chunk = String::from_utf8_lossy(&buf[before..]).to_string();
    Ok(chunk)
}
// 取出 since 之后**最早的那一帧**，并把 seq 推到这一帧。
// 之前取「最后一帧」会跳过中间帧，打字时画面一闪就没了。
// 现在逐帧消费：客户端每次拿到一帧，下次从这帧往后取。
fn term_drain(since: u64) -> (u64, String) {
    if let Ok(g) = TERM.lock() {
        if let Some(s) = g.as_ref() {
            if let Ok(bb) = s.buf.lock() {
                for (q, t) in bb.iter() {
                    if *q > since {
                        return (*q, t.clone());
                    }
                }
            }
            // 没有新帧：把 seq 推到当前值，避免重复拉取旧帧
            let cur = *s.seq.lock().unwrap_or_else(|e| e.into_inner());
            return (cur, String::new());
        }
    }
    (since, String::new())
}

// ---------------- ConPTY：给子进程一个真终端 ----------------
#[cfg(windows)]
mod pty {
    use crate::klog;
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::FromRawHandle;
    use std::ptr;

    pub type Handle = *mut core::ffi::c_void;

    #[repr(C)]
    #[derive(Default)]
    pub struct StartupInfoW {
        pub cb: u32,
        pub lpReserved: *mut u16,
        pub lpDesktop: *mut u16,
        pub lpTitle: *mut u16,
        pub dwX: u32,
        pub dwY: u32,
        pub dwXSize: u32,
        pub dwYSize: u32,
        pub dwXCountChars: u32,
        pub dwYCountChars: u32,
        pub dwFillAttribute: u32,
        pub dwFlags: u32,
        pub wShowWindow: u16,
        pub cbReserved2: u16,
        pub lpReserved2: *mut u8,
        pub hStdInput: Handle,
        pub hStdOutput: Handle,
        pub hStdError: Handle,
    }

    #[repr(C)]
    pub struct StartupInfoExW {
        pub si: StartupInfoW,
        pub attr: *mut core::ffi::c_void,
    }

    #[repr(C)]
    #[derive(Default)]
    pub struct ProcessInformation {
        pub hProcess: Handle,
        pub hThread: Handle,
        pub pid: u32,
        pub tid: u32,
    }

    #[link(name = "kernel32")]
    extern "system" {
        pub fn FreeConsole() -> i32;
        fn CreatePipe(r: *mut Handle, w: *mut Handle, sa: *mut core::ffi::c_void, n: u32) -> i32;
        fn CloseHandle(h: Handle) -> i32;
        fn CreatePseudoConsole(size: u32, input: Handle, output: Handle, flags: u32, out: *mut Handle) -> i32;
        fn InitializeProcThreadAttributeList(l: *mut core::ffi::c_void, c: u32, f: u32, size: *mut usize) -> i32;
        fn UpdateProcThreadAttribute(l: *mut core::ffi::c_void, f: u32, attr: usize, v: *mut core::ffi::c_void, sz: usize, p: *mut core::ffi::c_void, r: *mut usize) -> i32;
        fn CreateProcessW(app: *const u16, cmd: *mut u16, pa: *mut core::ffi::c_void, ta: *mut core::ffi::c_void, inh: i32, fl: u32, env: *mut core::ffi::c_void, cwd: *const u16, si: *mut StartupInfoW, pi: *mut ProcessInformation) -> i32;
    }

    fn wide(s: &str) -> Vec<u16> {
        OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
    }

    pub struct ConPty {
        pub reader: std::fs::File,
        pub writer: std::fs::File,
        pub pid: u32,
    }

    unsafe impl Send for ConPty {}

    /// 和最小复现程序完全一致的实现（已验证可用）
    pub fn spawn(cmdline: &str, cols: i16, rows: i16) -> Result<ConPty, String> {
        unsafe {
            let (mut in_r, mut in_w): (Handle, Handle) = (ptr::null_mut(), ptr::null_mut());
            let (mut out_r, mut out_w): (Handle, Handle) = (ptr::null_mut(), ptr::null_mut());
            assert!(CreatePipe(&mut in_r, &mut in_w, ptr::null_mut(), 0) != 0);
            assert!(CreatePipe(&mut out_r, &mut out_w, ptr::null_mut(), 0) != 0);

            // 低字 = 列数（宽），高字 = 行数（高）
            let size: u32 = ((rows as u32) << 16) | (cols as u32);
            let mut pc: Handle = ptr::null_mut();
            let hr = CreatePseudoConsole(size, in_r, out_w, 0, &mut pc);
            klog(&format!("    [pty] CreatePseudoConsole hr={}", hr));
            if hr != 0 {
                return Err("CreatePseudoConsole 失败".into());
            }

            let mut list_size: usize = 0;
            InitializeProcThreadAttributeList(ptr::null_mut(), 1, 0, &mut list_size);
            let mut mem: Vec<usize> = vec![0; (list_size + 7) / 8];
            let list = mem.as_mut_ptr() as *mut core::ffi::c_void;
            let ok1 = InitializeProcThreadAttributeList(list, 1, 0, &mut list_size);
            let ok2 = UpdateProcThreadAttribute(
                list, 0, 0x0002_0016,
                pc as *mut core::ffi::c_void, std::mem::size_of::<Handle>(),
                ptr::null_mut(), ptr::null_mut(),
            );
            klog(&format!("    [pty] InitAttr={} UpdateAttr={}", ok1, ok2));

            let mut si: StartupInfoExW = std::mem::zeroed();
            si.si.cb = std::mem::size_of::<StartupInfoExW>() as u32;
            si.attr = list;
            let mut pi: ProcessInformation = std::mem::zeroed();

            let mut cmd = wide(cmdline);
            let ok = CreateProcessW(
                ptr::null(), cmd.as_mut_ptr(), ptr::null_mut(), ptr::null_mut(), 0,
                0x0008_0000,
                ptr::null_mut(), ptr::null(), &mut si.si, &mut pi,
            );
            klog(&format!("    [pty] CreateProcessW={} pid={}", ok, pi.pid));
            if ok == 0 {
                return Err(format!("CreateProcessW 失败: {:?}", std::io::Error::last_os_error()));
            }

            // 这两端已经交给伪终端，主进程必须关掉自己的副本。
            // 不关的话，子进程 fork 出的孙进程会继承到错误句柄（Bad file descriptor）。
            CloseHandle(in_r);
            CloseHandle(out_w);

            Ok(ConPty {
                reader: std::fs::File::from_raw_handle(out_r as _),
                writer: std::fs::File::from_raw_handle(in_w as _),
                pid: pi.pid,
            })
        }
    }
}


// ---------------- 极简 VT 终端：在电脑端维护屏幕网格 ----------------
// ---- ANSI 颜色 → RGB ----
fn basic_color(i: usize) -> u32 {
    const P: [u32; 16] = [
        0x000000, 0xcd3131, 0x0dbc79, 0xe5e510, 0x2472c8, 0xbc3fbc, 0x11a8cd, 0xe5e5e5,
        0x666666, 0xf14c4c, 0x23d18b, 0xf5f543, 0x3b8eea, 0xd670d6, 0x29b8db, 0xffffff,
    ];
    P[i % 16]
}

fn xterm256(n: usize) -> u32 {
    if n < 16 { return basic_color(n); }
    if n < 232 {
        let i = n - 16;
        let r = (i / 36) as u32;
        let g = ((i % 36) / 6) as u32;
        let b = (i % 6) as u32;
        let f = |v: u32| if v == 0 { 0 } else { 55 + v * 40 };
        return (f(r) << 16) | (f(g) << 8) | f(b);
    }
    let v = (8 + (n - 232) as u32 * 10).min(255);
    (v << 16) | (v << 8) | v
}
mod vt {
    pub struct Screen {
        rows: usize,
        cols: usize,
        grid: Vec<Vec<(char, u32)>>,
        cur_r: usize,
        cur_c: usize,
        state: u8, // 0=ground 1=esc 2=csi 3=osc
        params: String,
        dirty: bool,
        cur_fg: u32,
        need_clear: bool,
        line_end: usize,
        alt: Option<Vec<Vec<(char, u32)>>>,
    }

    impl Screen {
        pub fn new(cols: usize, rows: usize) -> Self {
            Screen {
                rows,
                cols,
                grid: vec![vec![(' ', 0u32); cols]; rows],
                cur_r: 0,
                cur_c: 0,
                state: 0,
                params: String::new(),
                dirty: true,
                cur_fg: 0u32,
                need_clear: false,
                line_end: 0,
                alt: None,
            }
        }

        fn scroll(&mut self) {
            self.grid.remove(0);
            self.grid.push(vec![(' ', 0u32); self.cols]);
            self.line_end = 0;
        }

        fn put(&mut self, ch: char) {
            if self.cur_r >= self.rows {
                self.cur_r = self.rows - 1;
            }
            // 写到行尾就换行（标准终端的延迟折行）
            if self.cur_c >= self.cols {
                self.newline();
            }
            // readline 重绘：回到行首后第一次写入，先擦掉本行旧内容
            if self.need_clear {
                for c in self.cur_c..self.cols {
                    self.grid[self.cur_r][c] = (' ', 0u32);
                }
                self.need_clear = false;
            }
            self.grid[self.cur_r][self.cur_c] = (ch, self.cur_fg);
            self.cur_c += 1;
            if self.cur_c > self.line_end {
                self.line_end = self.cur_c;
            }
            self.dirty = true;
        }

        fn newline(&mut self) {
            // 换行了：上一行的重绘标记和行尾记录都归零
            self.need_clear = false;
            self.line_end = 0;
            // 关键：列也要归零。bash 在这条 pty 上只发 \n，
            // 不归零的话下一行会接着上一行的列位继续写（造成内容粘连）
            self.cur_c = 0;
            self.cur_r += 1;
            if self.cur_r >= self.rows {
                self.scroll();
                self.cur_r = self.rows - 1;
            }
            self.dirty = true;
        }

        fn csi(&mut self, fin: char) {
            // 参数里可能混着中间字节（空格等），先全部剔掉再按 ; 拆
            let clean: String = self
                .params
                .chars()
                .filter(|c| c.is_ascii_digit() || *c == ';')
                .collect();
            let nums: Vec<usize> = clean
                .split(';')
                .map(|s| s.parse::<usize>().unwrap_or(0))
                .collect();
            match fin {
                'H' | 'f' => {
                    let r = nums.first().copied().unwrap_or(1).max(1) - 1;
                    let c = nums.get(1).copied().unwrap_or(1).max(1) - 1;
                    self.cur_r = r.min(self.rows - 1);
                    self.cur_c = c.min(self.cols - 1);
                }
                'A' => self.cur_r = self.cur_r.saturating_sub(nums.first().copied().unwrap_or(1).max(1)),
                'B' => self.cur_r = (self.cur_r + nums.first().copied().unwrap_or(1).max(1)).min(self.rows - 1),
                'C' => self.cur_c = (self.cur_c + nums.first().copied().unwrap_or(1).max(1)).min(self.cols - 1),
                'D' => self.cur_c = self.cur_c.saturating_sub(nums.first().copied().unwrap_or(1).max(1)),
                'J' => {
                    let mode = nums.first().copied().unwrap_or(0);
                    if mode == 2 || mode == 3 {
                        for r in 0..self.rows {
                            for c in 0..self.cols {
                                self.grid[r][c] = (' ', 0u32);
                            }
                        }
                    } else {
                        for c in self.cur_c..self.cols {
                            self.grid[self.cur_r][c] = (' ', 0u32);
                        }
                        for r in self.cur_r + 1..self.rows {
                            for c in 0..self.cols {
                                self.grid[r][c] = (' ', 0u32);
                            }
                        }
                    }
                    self.dirty = true;
                }
                'K' => {
                    let mode = nums.first().copied().unwrap_or(0);
                    let start = if mode == 1 { 0 } else { self.cur_c };
                    let end = if mode == 0 { self.cols } else { self.cols };
                    for c in start..end {
                        if c < self.cols {
                            self.grid[self.cur_r][c] = (' ', 0u32);
                        }
                    }
                    self.dirty = true;
                }
                'm' => {
                    // SGR：只处理前景色（0/39 复位，30-37/90-97 基本色，38;5;n 256 色）
                    let mut i = 0usize;
                    while i < nums.len() {
                        match nums[i] {
                            0 | 39 => self.cur_fg = 0u32,
                            30..=37 => self.cur_fg = super::basic_color(nums[i] - 30),
                            90..=97 => self.cur_fg = super::basic_color(nums[i] - 90 + 8),
                            38 => {
                                if i + 2 < nums.len() && nums[i + 1] == 5 {
                                    self.cur_fg = super::xterm256(nums[i + 2]);
                                    i += 2;
                                }
                            }
                            _ => {}
                        }
                        i += 1;
                    }
                    self.dirty = true;
                }
                'h' | 'l' => {
                    // TUI 程序的备用屏：进入时保存主屏，退出时恢复。
                    // 不同程序用不同编号：1049 / 1047 / 47 都要认
                    let is_alt = self.params.contains("1049")
                        || self.params.contains("1047")
                        || self.params.contains("47");
                    if is_alt {
                        if fin == 'h' {
                            self.alt = Some(self.grid.clone());
                            for r in 0..self.rows {
                                for c in 0..self.cols {
                                    self.grid[r][c] = (' ', 0u32);
                                }
                            }
                            self.cur_r = 0;
                            self.cur_c = 0;
                        } else if let Some(saved) = self.alt.take() {
                            if saved.len() == self.rows {
                                self.grid = saved;
                            }
                            self.cur_r = 0;
                            self.cur_c = 0;
                        }
                        self.dirty = true;
                    }
                }
                _ => {}
            }
            self.params.clear();
        }

        pub fn feed(&mut self, text: &str) {
            for ch in text.chars() {
                match self.state {
                    0 => match ch {
                        '\u{1b}' => { self.state = 1; }
                        '\r' => {
                            // readline 重绘：回到行首。本行原有内容长度记下来，
                            // 重绘完如果更短，快照阶段由 line_end 兜底补空格。
                            self.need_clear = true;
                            self.cur_c = 0;
                            self.dirty = true;
                        }
                        '\n' => { self.newline(); }
                        '\u{8}' => { self.cur_c = self.cur_c.saturating_sub(1); }
                        '\t' => {
                            let next = ((self.cur_c / 8) + 1) * 8;
                            self.cur_c = next.min(self.cols - 1);
                        }
                        c if (c as u32) >= 0x20 => { self.put(c); }
                        _ => {}
                    },
                    1 => match ch {
                        '[' => { self.state = 2; self.params.clear(); }
                        ']' => { self.state = 3; }
                        // ESC ( ) * + # % 后面还要吃掉一个字符（字符集/编码切换），
                        // 不吃的话那个字符会被当成正文打印出来
                        '(' | ')' | '*' | '+' | '#' | '%' => { self.state = 4; }
                        _ => { self.state = 0; }
                    },
                    2 => {
                        // CSI 标准规则：参数字节 0x20-0x3F 一直累积，
                        // 直到终止字节 0x40-0x7E 才结束。
                        // 之前用「非数字即结束」，遇到 ESC[4 q 这种就散架了，
                        // 剩下的字符会被当正文打印（屏幕上those 4 / m 就是这么来的）。
                        let code = ch as u32;
                        if (0x20..=0x3F).contains(&code) {
                            self.params.push(ch);
                        } else if (0x40..=0x7E).contains(&code) {
                            self.csi(ch);
                            self.state = 0;
                        } else {
                            self.state = 0;
                        }
                    }
                    3 => {
                        // OSC：BEL 或 ESC \ (ST) 结束
                        if ch == '\u{7}' {
                            self.state = 0;
                        } else if ch == '\u{1b}' {
                            self.state = 5;
                        }
                    }
                    4 => { self.state = 0; }   // 吞掉 ESC( 后面的那一个字符
                    5 => { self.state = 0; }   // 吞掉 OSC 的 ST 结尾
                    _ => { self.state = 0; }
                }
            }
        }

        /// 整屏快照：每行去掉尾部空格
        pub fn snapshot(&mut self) -> String {
            self.dirty = false;
            let mut out = String::new();
            for r in 0..self.rows {
                let line: String = self.grid[r].iter().map(|(c, _)| *c).collect();
                out.push_str(line.trim_end());
                if r + 1 < self.rows {
                    out.push('\n');
                }
            }
            // 去掉末尾空行
            while out.ends_with('\n') {
                out.pop();
            }
            // 颜色块：按行做游程编码，只列非默认色的片段
            // 格式：行:起-止:RRGGBB;...
            let mut colors = String::new();
            for r in 0..self.rows {
                let mut c = 0usize;
                while c < self.cols {
                    let fg = self.grid[r][c].1;
                    if fg == 0 {
                        c += 1;
                        continue;
                    }
                    let start = c;
                    while c < self.cols && self.grid[r][c].1 == fg {
                        c += 1;
                    }
                    if !colors.is_empty() {
                        colors.push(';');
                    }
                    colors.push_str(&format!("{}:{}-{}:{:06x}", r, start, c - 1, fg));
                }
            }
            if !colors.is_empty() {
                out.push('\n');
                out.push_str("#K");
                out.push_str(&colors);
            }
            out
        }

        pub fn take_if_dirty(&mut self) -> Option<String> {
            if self.dirty {
                let body = self.snapshot();
                // 头部带上光标位置，手机端据此决定「正在输入的内容」画在哪一行。
                // 不带的话，TUI 里文字会被拼到最后一行（状态栏），位置就错了。
                Some(format!("#C{};{}\n{}", self.cur_r, self.cur_c, body))
            } else {
                None
            }
        }
    }
}

static SCREEN: Mutex<Option<vt::Screen>> = Mutex::new(None);
static SCREEN_GEN: Mutex<u64> = Mutex::new(0);

fn vt_feed(gen: u64, text: &str) -> Option<String> {
    if let Ok(cur) = SCREEN_GEN.lock() {
        if *cur != gen {
            return None;  // 这是旧会话的残留线程，丢弃
        }
    }
    if let Ok(mut g) = SCREEN.lock() {
        if g.is_none() {
            *g = Some(vt::Screen::new(120, 40));
        }
        if let Some(s) = g.as_mut() {
            s.feed(text);
            return s.take_if_dirty();
        }
    }
    None
}

