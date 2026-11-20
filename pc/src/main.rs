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

const VERSION: &str = "1.5.0";

/// 项目自带的云函数网关（教育版环境）。用户不传 --gw 时用它，开箱即用。
const DEFAULT_GW: &str = "https://eval-lifecycle-d7gf433u22f6c2405-1520376176.ap-shanghai.app.tcloudbase.com/kuaichuan";

/// 进程启动时间（毫秒时间戳），控制台用来算运行时长
static START_MS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// 网页控制台：取代黑窗口，浏览器里看状态、改配置、看日志
const CONSOLE_HTML: &str = r####"<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>快传 · 电脑端控制台</title>
<style>
*{box-sizing:border-box}
body{margin:0;background:#0b0c0e;color:#c6cad0;font:14px/1.6 -apple-system,"Segoe UI",system-ui,sans-serif}
header{display:flex;align-items:center;gap:12px;padding:18px 24px;border-bottom:1px solid #1d2027;position:sticky;top:0;background:#0b0c0e;z-index:9}
h1{font-size:17px;margin:0;color:#e8eaed;font-weight:600}
.ver{font-size:12px;color:#5a6068}
.pill{margin-left:auto;font-size:12px;padding:4px 12px;border-radius:99px;border:1px solid #23272e;color:#8b9199}
.pill.on{color:#5fd08a;border-color:#1e3a2a;background:#0f1a14}
.pill.off{color:#e0846f;border-color:#3a2226;background:#1a0f10}
main{padding:20px 24px;max-width:1100px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:24px}
.card{background:#121418;border:1px solid #1d2027;border-radius:10px;padding:14px 16px}
.card label{display:block;font-size:12px;color:#5a6068;margin-bottom:6px}
.card b{font-size:20px;color:#e8eaed;font-weight:600;word-break:break-all}
.card b.mono{font-family:ui-monospace,Consolas,monospace;font-size:16px}
h2{font-size:14px;color:#8b9199;margin:26px 0 10px;font-weight:600}
.row{display:flex;align-items:center;gap:10px;padding:10px 14px;background:#121418;border:1px solid #1d2027;border-radius:8px;margin-bottom:8px}
.row .n{color:#e8eaed}
.row .p{font-size:12px;color:#4d535a;font-family:ui-monospace,monospace;margin-left:auto;max-width:55%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tag{font-size:11px;color:#8fb4d9;background:#151a21;border:1px solid #232b36;border-radius:5px;padding:1px 7px}
pre{background:#0e1013;border:1px solid #1d2027;border-radius:8px;padding:14px;font-family:ui-monospace,Consolas,monospace;font-size:12px;line-height:1.7;color:#8b9199;max-height:320px;overflow:auto;margin:0;white-space:pre-wrap}
button{background:#1a1f26;color:#c6cad0;border:1px solid #2c3138;border-radius:8px;padding:8px 16px;font-size:13px;cursor:pointer}
button:hover{background:#222832}
button.primary{background:#e8eaed;color:#0b0c0e;border-color:#e8eaed}
.empty{color:#4d535a;font-size:13px;padding:14px}
</style></head><body>
<header>
  <h1>快传 · 电脑控制端</h1><span class="ver" id="ver"></span>
  <span class="pill" id="state">连接中…</span>
</header>
<main>
  <div class="cards">
    <div class="card"><label>配对码</label><b class="mono" id="code">-</b></div>
    <div class="card"><label>运行模式</label><b id="mode">-</b></div>
    <div class="card"><label>运行时长</label><b id="up">-</b></div>
    <div class="card"><label>已识别智能体</label><b id="agc">-</b></div>
  </div>

  <h2>智能体</h2>
  <div id="agents"><div class="empty">读取中…</div></div>

  <h2>设备归属</h2>
  <div class="row">
    <span class="n" id="ownTxt">查询中…</span>
    <button id="unbindBtn" style="margin-left:auto;display:none">解除绑定</button>
  </div>
  <div class="sub" style="font-size:12px;color:#4d535a;margin-top:6px">
    解除后这台电脑变成未归属，手机上要用配对码重新接入
  </div>

  <h2>配置文件</h2>
  <div id="cfgs"><div class="empty">读取中…</div></div>
  <div id="editorBox" style="display:none;margin-top:12px">
    <div class="row"><span class="n" id="edName">-</span><span class="p" id="edPath"></span></div>
    <textarea id="ed" style="width:100%;height:300px;background:#0e1013;border:1px solid #1d2027;border-radius:8px;padding:12px;color:#c6cad0;font:12px/1.7 ui-monospace,Consolas,monospace;resize:vertical"></textarea>
    <div style="margin-top:10px;display:flex;gap:10px">
      <button class="primary" id="saveBtn">保存到磁盘</button>
      <button id="closeBtn">关闭</button>
      <span style="font-size:12px;color:#5a6068;align-self:center" id="edHint"></span>
    </div>
  </div>

  <h2>运行日志</h2>
  <pre id="log">读取中…</pre>
  <div style="margin-top:10px"><button id="refreshLog">刷新日志</button></div>
</main>
<script>
var Q = new URLSearchParams(location.search);
var T = Q.get('t') || '';

function hdr() { return { 'X-KC-Token': T, 'Content-Type': 'application/json' }; }
function api(p, opt) {
  return fetch(p + (p.indexOf('?') >= 0 ? '&' : '?') + 't=' + encodeURIComponent(T), opt)
    .then(function (r) { return r.json(); });
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  });
}
function dur(ms) {
  var s = Math.floor(ms / 1000), d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600),
      m = Math.floor(s % 3600 / 60), ss = s % 60;
  if (d) return d + '天' + h + '小时';
  if (h) return h + '小时' + m + '分';
  if (m) return m + '分' + ss + '秒';
  return ss + '秒';
}

function loadStatus() {
  api('/status').then(function (s) {
    if (!s || !s.ok) { document.getElementById('state').textContent = '需配对码'; return; }
    document.getElementById('ver').textContent = 'v' + s.version;
    document.getElementById('code').textContent = s.code || '-';
    document.getElementById('mode').textContent = s.modeLabel || s.mode;
    document.getElementById('up').textContent = dur(s.uptimeMs);
    document.getElementById('agc').textContent = (s.agents || []).length;
    var st = document.getElementById('state');
    st.textContent = s.gateway ? '云端已连接' : '本地待连接';
    st.className = 'pill ' + (s.gateway ? 'on' : 'off');

    var box = document.getElementById('agents');
    if (!s.agents || !s.agents.length) { box.innerHTML = '<div class="empty">没扫到已知智能体</div>'; return; }
    box.innerHTML = s.agents.map(function (a) {
      return '<div class="row"><span class="n">' + esc(a.name) + '</span>' +
             '<span class="tag">' + esc(a.version || '未知') + '</span>' +
             '<span class="p" title="' + esc(a.path) + '">' + esc(a.path) + '</span></div>';
    }).join('');
  }).catch(function () {
    document.getElementById('state').textContent = '连不上服务';
    document.getElementById('state').className = 'pill off';
  });
}

function loadOwner() {
  api('/owner').then(function (r) {
    var el = document.getElementById('ownTxt');
    var btn = document.getElementById('unbindBtn');
    if (!r || !r.ok) { el.textContent = '查询失败'; return; }
    if (r.bound) {
      el.textContent = '已绑定：' + (r.owner || '某个账号');
      btn.style.display = 'inline-block';
    } else {
      el.textContent = r.note || '未绑定任何账号';
      btn.style.display = 'none';
    }
  }).catch(function () {
    document.getElementById('ownTxt').textContent = '查询失败（需要云端模式）';
  });
}
document.getElementById('unbindBtn').onclick = function () {
  if (!confirm('解除这台电脑的绑定？手机上需要用配对码重新接入。')) return;
  api('/unbind', { method: 'POST', headers: hdr(), body: '{}' }).then(function (r) {
    if (r && r.ok) { alert('已解除绑定'); loadOwner(); }
    else { alert('失败：' + ((r && r.error) || '未知')); }
  });
};

function loadCfgs() {
  api('/configs').then(function (r) {
    var box = document.getElementById('cfgs');
    if (!r || !r.ok || !r.list || !r.list.length) { box.innerHTML = '<div class="empty">没有可编辑的配置</div>'; return; }
    box.innerHTML = r.list.map(function (c, i) {
      return '<div class="row" style="cursor:pointer" data-i="' + i + '">' +
        '<span class="n">' + esc(c.agent) + ' · ' + esc(c.label) + '</span>' +
        '<span class="tag">' + (c.exists ? Math.round(c.size / 1024 * 10) / 10 + ' KB' : '不存在') + '</span>' +
        '<span class="p" title="' + esc(c.path) + '">' + esc(c.path) + '</span></div>';
    }).join('');
    Array.prototype.forEach.call(box.querySelectorAll('.row'), function (el) {
      el.onclick = function () { openCfg(r.list[+el.getAttribute('data-i')]); };
    });
  }).catch(function () { });
}

var CUR = null;
function openCfg(c) {
  CUR = c;
  api('/config_read', { method: 'POST', headers: hdr(), body: JSON.stringify({ id: c.id }) })
    .then(function (r) {
      if (!r || !r.ok) { alert(r && r.error || '读取失败'); return; }
      document.getElementById('editorBox').style.display = 'block';
      document.getElementById('edName').textContent = c.agent + ' · ' + c.label;
      document.getElementById('edPath').textContent = c.path;
      document.getElementById('ed').value = r.content || '';
      document.getElementById('edHint').textContent = r.masked
        ? '含密钥字段已打码（__KC_MASKED__），保存时会自动换回原值' : '';
    });
}
document.getElementById('saveBtn').onclick = function () {
  if (!CUR) return;
  if (!confirm('保存到 ' + CUR.path + '？会先备份一份原文件。')) return;
  api('/config_write', {
    method: 'POST', headers: hdr(),
    body: JSON.stringify({ id: CUR.id, content: document.getElementById('ed').value })
  }).then(function (r) {
    if (r && r.ok) { alert('已保存' + (r.backup ? '\n备份：' + r.backup : '')); loadCfgs(); }
    else { alert('写入失败：' + ((r && r.error) || '未知')); }
  });
};
document.getElementById('closeBtn').onclick = function () {
  document.getElementById('editorBox').style.display = 'none';
  CUR = null;
};

function loadLog() {
  api('/log').then(function (r) {
    document.getElementById('log').textContent = (r && r.text) || '（没有日志）';
  }).catch(function () { document.getElementById('log').textContent = '（读取失败）'; });
}
document.getElementById('refreshLog').onclick = loadLog;

loadStatus(); loadCfgs(); loadLog(); loadOwner();
setInterval(loadStatus, 3000);
setInterval(loadLog, 5000);
</script>
</body></html>"####;

static SESSION_CWD: Mutex<Option<String>> = Mutex::new(None);

fn get_cwd() -> String {
    SESSION_CWD.lock().ok().and_then(|g| g.clone()).unwrap_or_default()
}
fn set_cwd(v: &str) {
    if let Ok(mut g) = SESSION_CWD.lock() { *g = Some(v.to_string()); }
}
const MAX_OUT: usize = 8192;

#[derive(Clone)]
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
        pty::FreeConsole();
        // 放开之后立刻挂回父控制台，否则后面所有 println! 都进了黑洞，
        // 用户在 PowerShell 里看不到任何启动信息和报错
        if pty::AttachConsole(u32::MAX) != 0 {
            // Rust 的 println! 走 GetStdHandle，不是 CRT 的 fd，
            // 所以必须用 SetStdHandle 换掉标准输出句柄，dup2 没用
            let h = pty::CreateFileA(
                b"CONOUT$\0".as_ptr(),
                0x8000_0000 | 0x4000_0000, // GENERIC_READ|GENERIC_WRITE
                1 | 2,                     // FILE_SHARE_READ|WRITE
                core::ptr::null_mut(),
                3,                         // OPEN_EXISTING
                0,
                core::ptr::null_mut(),
            );
            if h != core::ptr::null_mut() && h as isize != -1 {
                pty::SetStdHandle(0xFFFF_FFF5, h); // STD_OUTPUT_HANDLE
                pty::SetStdHandle(0xFFFF_FFF4, h); // STD_ERROR_HANDLE
            }
        }
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

    // 令牌优先级：显式 --token > 配对码 --code > 随机
    // 用配对码当令牌，小程序拿到设备记录就能连着直连局域网，不用额外记一串码
    // 先读持久化的配对码（与 run_gateway 同逻辑），否则无参数启动时 device_code 还是空，
    // 会走随机 token —— 自动弹出的控制台 URL 每次都变，用户根本进不去。
    if cfg.device_code.is_empty() {
        cfg.device_code = read_trim(&exe_dir().join(".device-code")).unwrap_or_default();
    }
    if cfg.token.is_empty() {
        if !cfg.device_code.is_empty() {
            cfg.token = cfg.device_code.clone();
        } else {
            cfg.token = gen_token();
        }
    }

    START_MS.store(now_ms() as u64, std::sync::atomic::Ordering::Relaxed);

    // 开箱即用：不带任何模式参数时默认走云网关模式（自带默认网关地址）。
    // 否则双击 exe 会进入只有本机能访问的本地模式，手机根本连不上。
    if !cfg.gw && !cfg.cloud {
        cfg.gw = true;
        // 控制台线程在 run_gateway 之前就克隆了 cfg，网关地址要在这里补齐，
        // 否则控制台会显示 mode=local、gateway 为空
        cfg.gw_url = DEFAULT_GW.to_string();
    }

    if cfg.gw {
        // 云端模式也要有个本地控制台：一个进程干两件事，
        // 手机走云端中转，主人在电脑上打开网页看状态。
        {
            // 云端模式下同时监听 0.0.0.0：手机在同一 WiFi 就直连，
            // 不在同一网才走云端中转。两条路并存，谁快走谁。
            let addr = format!("0.0.0.0:{}", cfg.port);
            let app = App {
                cfg: Arc::new(cfg.clone()),
                agents: Arc::new(Mutex::new(Vec::new())),
            };
            let app_probe = app.clone();
            thread::spawn(move || {
                let list = detect_agents();
                *app_probe.agents.lock().unwrap() = list;
            });
            let app_srv = app.clone();
            let console_url = format!("http://127.0.0.1:{}/?t={}", cfg.port, cfg.token);
            let lan_url = local_ip().ok().map(|ip| format!("http://{}:{}/?t={}", ip, cfg.port, cfg.token));
            thread::spawn(move || {
                match TcpListener::bind(&addr) {
                    Err(e) => {
                        // 云端模式下绑不上端口必须退出：
                        // 否则第二份进程会连着同一个云端任务队列，同一条命令被执行两次
                        println!("  ! 端口 {} 被占用，无法启动控制台: {}", cfg.port, e);
                        println!("    已有实例在跑？先关掉它，或换 --port");
                        std::process::exit(1);
                    }
                    Ok(l) => {
                        println!();
                        println!("  ┌─────────────────────────────────────────");
                        println!("  │ 控制台  {}", console_url);
                        if let Some(u) = lan_url {
                            println!("  │ 局域网  {}", u);
                        }
                        println!("  └─────────────────────────────────────────");
                        // 顺手把控制台在默认浏览器里打开：
                        // 走 cmd /c start 而不是直接 spawn explorer——
                        // 有机器上 explorer 被 shell 扩展/注入搞坏时会弹
                        // 「应用程序无法正常启动(0xc0000142)」，cmd start 走
                        // ShellExecute 链路更稳，也避免 GUI 崩溃弹窗打扰用户。
                        {
                            let mut c = Command::new("cmd");
                            c.args(["/C", "start", "", &console_url]);
                            no_window(&mut c);
                            let _ = c.spawn();
                        }
                        for s in l.incoming() {
                            if let Ok(s) = s {
                                let a = app_srv.clone();
                                thread::spawn(move || handle_conn(s, a));
                            }
                        }
                    }
                    Err(e) => {
                        println!("  ! 控制台端口 {} 被占用（{}），网页控制台不可用", cfg.port, e);
                    }
                }
            });
        }
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

    // 控制台页面本身不需要配对码，但它的 API 需要。
    // 配对码也可以从 URL 的 ?t= 传进来，方便直接点开链接。
    if token_hdr.is_empty() {
        if let Some(qs) = path_full.split('?').nth(1) {
            for kv in qs.split('&') {
                if let Some(v) = kv.strip_prefix("t=") {
                    token_hdr = v.to_string();
                }
            }
        }
    }
    let need_token = path != "/ping" && path != "/" && path != "/favicon.ico";
    if need_token && token_hdr != app.cfg.token {
        respond(&mut stream, 401, &format!("{{\"ok\":false,\"error\":\"token mismatch\",\"needToken\":true}}"), "application/json");
        return;
    }

    match (method.as_str(), path.as_str()) {
        // 这台电脑归谁 —— 控制台上显示
        // 调试用：倒出常驻 Shell 的原始输出流
        ("GET", "/raw") => {
            let s = if let Ok(g) = TERM.lock() {
                match g.as_ref() {
                    Some(ts) => ts.raw.lock().map(|r| r.clone()).unwrap_or_default(),
                    None => String::from("<无会话>"),
                }
            } else {
                String::from("<锁失败>")
            };
            let tail = if s.len() > 3000 { &s[s.len() - 3000..] } else { &s[..] };
            let body = format!("{{\"ok\":true,\"len\":{},\"raw\":\"{}\"}}", s.len(), esc(tail));
            respond(&mut stream, 200, &body, "application/json");
        }
        ("GET", "/owner") => {
            // 注意：不要把「调用失败」伪装成「模式不支持」，
            // 之前就是这么写的，导致云端模式下也显示「仅云端模式可用」，误导排查
            if app.cfg.gw_url.is_empty() {
                respond(&mut stream, 200,
                    "{\"ok\":true,\"bound\":false,\"owner\":\"\",\"note\":\"当前不是云端模式，查不到归属\"}",
                    "application/json");
                return;
            }
            let body = format!("{{\"action\":\"device_self_status\",\"deviceCode\":\"{}\"}}",
                gw_json_url(&app.cfg.device_code));
            let key = match read_key() {
                Some(k) => k,
                None => {
                    respond(&mut stream, 500,
                        "{\"ok\":false,\"error\":\"找不到 .cloudbase-apikey（要和 exe 放同一目录）\"}",
                        "application/json");
                    return;
                }
            };
            match gw_call(&app.cfg.gw_url, &key, &body) {
                Ok(r) => respond(&mut stream, 200, &r, "application/json"),
                Err(e) => {
                    let b = format!("{{\"ok\":false,\"error\":\"云端查询失败: {}\"}}", esc(&e));
                    respond(&mut stream, 502, &b, "application/json");
                }
            }
        }
        ("POST", "/unbind") => {
            if app.cfg.gw_url.is_empty() {
                respond(&mut stream, 400, "{\"ok\":false,\"error\":\"仅云端模式可解绑\"}", "application/json");
                return;
            }
            let key = match read_key() {
                Some(k) => k,
                None => {
                    respond(&mut stream, 500, "{\"ok\":false,\"error\":\"找不到 API Key\"}", "application/json");
                    return;
                }
            };
            let body = format!("{{\"action\":\"device_self_release\",\"deviceCode\":\"{}\"}}",
                gw_json_url(&app.cfg.device_code));
            match gw_call(&app.cfg.gw_url, &key, &body) {
                Ok(r) => respond(&mut stream, 200, &r, "application/json"),
                Err(e) => {
                    let b = format!("{{\"ok\":false,\"error\":\"{}\"}}", esc(&e));
                    respond(&mut stream, 500, &b, "application/json");
                }
            }
        }
        // ---- 网页控制台 ----
        ("GET", "/") => {
            respond(&mut stream, 200, CONSOLE_HTML, "text/html; charset=utf-8");
        }
        ("GET", "/favicon.ico") => {
            respond(&mut stream, 204, "", "text/plain");
        }
        ("GET", "/status") => {
            let agents = app.agents.lock().unwrap().clone();
            let start = START_MS.load(std::sync::atomic::Ordering::Relaxed);
            let now = now_ms() as u64;
            let uptime = if start > 0 && now > start { now - start } else { 0 };
            let mode = if !app.cfg.gw_url.is_empty() {
                "gw"
            } else if app.cfg.lan {
                "lan"
            } else {
                "local"
            };
            let mode_label = match mode {
                "gw" => "云端中转",
                "lan" => "局域网",
                _ => "本机",
            };
            let body = format!(
                "{{\"ok\":true,\"version\":\"{}\",\"code\":\"{}\",\"mode\":\"{}\",\"modeLabel\":\"{}\",\"port\":{},\"gateway\":\"{}\",\"uptimeMs\":{},\"agents\":{}}}",
                VERSION, esc(&app.cfg.token), mode, mode_label, app.cfg.port,
                esc(&app.cfg.gw_url), uptime, agents_json(&agents)
            );
            respond(&mut stream, 200, &body, "application/json");
        }
        ("GET", "/log") => {
            // 读 exe 同目录的 gw.log 尾部
            let dir = std::env::current_exe().ok()
                .and_then(|p| p.parent().map(|d| d.to_path_buf()));
            let mut text = String::new();
            if let Some(d) = dir {
                if let Ok(all) = std::fs::read_to_string(d.join("gw.log")) {
                    let lines: Vec<&str> = all.lines().collect();
                    let start = lines.len().saturating_sub(200);
                    text = lines[start..].join("\n");
                }
            }
            let body = format!("{{\"ok\":true,\"text\":\"{}\"}}", esc(&text));
            respond(&mut stream, 200, &body, "application/json");
        }        ("GET", "/ping") => {
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
        // 配置文件白名单：只暴露这些，别的路径一律拒绝
        ("GET", "/configs") => {
            let mut items: Vec<String> = Vec::new();
            for c in config_allowlist() {
                let exists = c.path.is_file();
                let size = if exists { std::fs::metadata(&c.path).map(|m| m.len()).unwrap_or(0) } else { 0 };
                let modified = if exists {
                    std::fs::metadata(&c.path).ok()
                        .and_then(|m| m.modified().ok())
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_millis() as u64)
                        .unwrap_or(0)
                } else { 0 };
                items.push(format!(
                    "{{\"id\":\"{}\",\"agent\":\"{}\",\"label\":\"{}\",\"path\":\"{}\",\"exists\":{},\"size\":{},\"modified\":{}}}",
                    esc(&c.id), esc(c.agent), esc(c.label),
                    esc(&c.path.to_string_lossy()), exists, size, modified
                ));
            }
            let body = format!("{{\"ok\":true,\"list\":[{}]}}", items.join(","));
            respond(&mut stream, 200, &body, "application/json");
        }
        ("POST", "/config_read") => {
            let id = json_str(&body_str, "id").unwrap_or_default();
            let hit = config_allowlist().into_iter().find(|c| c.id == id);
            let c = match hit {
                Some(c) => c,
                None => {
                    respond(&mut stream, 403, "{\"ok\":false,\"error\":\"不在允许列表里\"}", "application/json");
                    return;
                }
            };
            if !c.path.is_file() {
                respond(&mut stream, 404, "{\"ok\":false,\"error\":\"文件不存在\"}", "application/json");
                return;
            }
            match std::fs::read_to_string(&c.path) {
                Ok(mut text) => {
                    // 太长的不适合在手机上编辑
                    if text.len() > 200_000 {
                        text.truncate(200_000);
                        text.push_str("\n…（内容过长，已截断）");
                    }
                    let truncated = text.len() >= 200_000;
                    let masked = mask_secrets(&text);
                    let body = format!(
                        "{{\"ok\":true,\"id\":\"{}\",\"content\":\"{}\",\"truncated\":{},\"masked\":{}}}",
                        esc(&c.id), esc(&masked), truncated, masked.contains(MASK)
                    );
                    respond(&mut stream, 200, &body, "application/json");
                }
                Err(e) => {
                    let body = format!("{{\"ok\":false,\"error\":\"读取失败: {}\"}}", esc(&e.to_string()));
                    respond(&mut stream, 500, &body, "application/json");
                }
            }
        }
        ("POST", "/config_write") => {
            let id = json_str(&body_str, "id").unwrap_or_default();
            let content = json_str(&body_str, "content").unwrap_or_default();
            let hit = config_allowlist().into_iter().find(|c| c.id == id);
            let c = match hit {
                Some(c) => c,
                None => {
                    respond(&mut stream, 403, "{\"ok\":false,\"error\":\"不在允许列表里\"}", "application/json");
                    return;
                }
            };
            // 读原文件，把 __KC_MASKED__ 还原成真实值，否则会把 Key 写成占位符
            let content = if content.contains(MASK) && c.path.is_file() {
                match std::fs::read_to_string(&c.path) {
                    Ok(old) => restore_masked(&content, &old),
                    Err(_) => content,
                }
            } else {
                content
            };

            // 写之前先备份一份，改坏了能找回
            let bak = if c.path.is_file() {
                let b = c.path.with_extension(format!("bak-{}",
                    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_secs()).unwrap_or(0)));
                match std::fs::copy(&c.path, &b) {
                    Ok(_) => Some(b),
                    Err(_) => None,
                }
            } else { None };

            if let Some(dir) = c.path.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            match std::fs::write(&c.path, content.as_bytes()) {
                Ok(_) => {
                    klog(&format!("    [config] 写入 {}", c.path.to_string_lossy()));
                    let body = format!(
                        "{{\"ok\":true,\"id\":\"{}\",\"backup\":\"{}\"}}",
                        esc(&c.id),
                        esc(&bak.map(|p| p.to_string_lossy().to_string()).unwrap_or_default())
                    );
                    respond(&mut stream, 200, &body, "application/json");
                }
                Err(e) => {
                    let body = format!("{{\"ok\":false,\"error\":\"写入失败: {}\"}}", esc(&e.to_string()));
                    respond(&mut stream, 500, &body, "application/json");
                }
            }
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

            // 走常驻 Shell：cd、export 这类状态能延续到下一条命令，
            // 不再每条都新起一个进程（以前 cd 完再 pwd 还是老目录）
            let started = now_ms();
            if !cwd.trim().is_empty() {
                let _ = term_run(&format!("cd \"{}\"", cwd.trim().trim_matches('"')), 8000);
            }
            let (ok, out, err, code) = match term_run(&cmd, tmo) {
                Ok((o, c)) => (true, o, String::new(), c),
                Err(e) => (false, String::new(), e, 1),
            };
            let body = format!(
                "{{\"ok\":{},\"cmd\":\"{}\",\"exitCode\":{},\"stdout\":\"{}\",\"stderr\":\"{}\",\"shell\":\"persistent\",\"ms\":{},\"timedOut\":false}}",
                ok,
                esc(&cmd),
                code,
                esc(&out),
                esc(&err),
                now_ms().saturating_sub(started)
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

            let args = agent_args(&exe, &text);

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
    ("DeepSeek Harness", &["dsh.cmd", "dsh.exe", "dsh"]),
    // 注意：不要在这里加「DeepSeek Harness.exe」等 GUI 程序。
    // 它们是 Electron 外壳，headless 起不来——会去抢正在运行界面的缓存锁，
    // 然后吐一句 net\disk_cache 的 ERROR 就退出，用户只会看到报错。
    // 要驱动 DSH 就用上面的 CLI（dsh --profile headless）。
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

/// 这些 key 名看起来就带密钥，值要打码
fn looks_secret_key(k: &str) -> bool {
    let k = k.to_lowercase();
    ["token", "key", "secret", "password", "passwd", "auth", "credential", "bearer"]
        .iter().any(|p| k.contains(p))
}

const MASK: &str = "__KC_MASKED__";

/// 读出前把敏感值打码，防止 API Key 出现在手机屏幕和聊天记录里
fn mask_secrets(text: &str) -> String {
    let mut out: Vec<String> = Vec::new();
    for line in text.lines() {
        let pos = line.find(": ").or_else(|| line.find('=')).or_else(|| line.find(':'));
        let masked = match pos {
            Some(i) => {
                let key = &line[..i];
                if looks_secret_key(key) {
                    let rest = &line[i..];
                    let sep_len = if rest.starts_with(": ") || rest.starts_with("= ") { 2 } else { 1 };
                    let (sep, val) = rest.split_at(sep_len.min(rest.len()));
                    let trail = if val.trim_end().ends_with(',') { "," } else { "" };
                    format!("{}{}\"{}\"{}", key, sep, MASK, trail)
                } else {
                    line.to_string()
                }
            }
            None => line.to_string(),
        };
        out.push(masked);
    }
    let mut r = out.join("\n");
    // 保留原文件末尾的换行，否则每次保存都会吃掉一个换行
    if text.ends_with('\n') { r.push('\n'); }
    r
}

/// 写回时把占位符换回原值，否则会把用户的 Key 覆盖成占位符
fn restore_masked(new_text: &str, old_text: &str) -> String {
    if !new_text.contains(MASK) {
        return new_text.to_string();
    }
    // 旧文件的 key → 原值
    let mut map: Vec<(String, String)> = Vec::new();
    for line in old_text.lines() {
        let pos = line.find(": ").or_else(|| line.find('=')).or_else(|| line.find(':'));
        if let Some(i) = pos {
            let key = line[..i].trim().trim_matches('"').to_string();
            let rest = &line[i..];
            let sep_len = if rest.starts_with(": ") || rest.starts_with("= ") { 2 } else { 1 };
            let val = rest[sep_len.min(rest.len())..].trim().trim_end_matches(',').trim_matches('"').to_string();
            if !key.is_empty() {
                map.push((key, val));
            }
        }
    }

    let mut out: Vec<String> = Vec::new();
    for line in new_text.lines() {
        if line.contains(MASK) {
            let pos = line.find(": ").or_else(|| line.find('=')).or_else(|| line.find(':'));
            if let Some(i) = pos {
                let key = line[..i].trim().trim_matches('"').to_string();
                if let Some((_, orig)) = map.iter().find(|(k, _)| *k == key) {
                    let rest = &line[i..];
                    let sep_len = if rest.starts_with(": ") || rest.starts_with("= ") { 2 } else { 1 };
                    let (sep, val) = rest.split_at(sep_len.min(rest.len()));
                    let trail = if val.trim_end().ends_with(',') { "," } else { "" };
                    out.push(format!("{}{}\"{}\"{}", &line[..i], sep, orig, trail));
                    continue;
                }
            }
        }
        out.push(line.to_string());
    }
    let mut r = out.join("\n");
    if new_text.ends_with('\n') { r.push('\n'); }
    r
}
/// 读 exe 同目录的 .cloudbase-apikey
fn read_key() -> Option<String> {
    let dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    read_trim(&dir.join(".cloudbase-apikey"))
}

/// 允许手机读写的配置文件（白名单，写死）
///
/// 安全边界：只放非敏感配置。
/// 明确排除 .env / .credentials* / auth* / *.lock —— 那些含 API Key，
/// 不该通过手机传，也不该在聊天记录里留痕。
struct CfgItem {
    id: &'static str,
    agent: &'static str,
    label: &'static str,
    path: std::path::PathBuf,
}

fn config_allowlist() -> Vec<CfgItem> {
    let home = env::var("USERPROFILE")
        .or_else(|_| env::var("HOME"))
        .unwrap_or_default();
    let local = env::var("LOCALAPPDATA").unwrap_or_default();
    let h = Path::new(&home);
    let l = Path::new(&local);

    vec![
        CfgItem { id: "claude-settings", agent: "Claude Code", label: "用户设置", path: h.join(".claude").join("settings.json") },
        CfgItem { id: "claude-md", agent: "Claude Code", label: "全局指令", path: h.join(".claude").join("CLAUDE.md") },
        CfgItem { id: "codex-config", agent: "Codex CLI", label: "配置", path: h.join(".codex").join("config.toml") },
        CfgItem { id: "dsh-patch", agent: "DeepSeek Harness", label: "补丁配置", path: h.join(".dsh").join("cordis.patch.yml") },
        CfgItem { id: "hermes-config", agent: "Hermes", label: "配置", path: l.join("hermes").join("config.yaml") },
    ]
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
    list_objects_in(json, "list")
}

/// 按数组键提取对象列表（sync 响应里 commands/termIn/agentIn 是各自独立的数组）
fn list_objects_in(json: &str, key: &str) -> Vec<String> {
    let mut out = Vec::new();
    let bytes = json.as_bytes();
    let pat = format!("\"{}\"", key);
    let lpos = match find_sub(bytes, pat.as_bytes()) {
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
        eprintln!("没找到服务密钥（.cloudbase-apikey）。");
        eprintln!("请下载完整 zip 分发包（内含密钥文件，解压后双击\"启动快传.cmd\"即可），");
        eprintln!("或把 .cloudbase-apikey 放到本 exe 同目录 / 用 --apikey 传入。");
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
    // 不碰 %TEMP%、也不靠管道抓 stdout：
    // 受限环境（沙箱 / 组策略 / 某些 EDR）下创建管道会被拒（os error 5），
    // %TEMP% 也可能不可写。改成请求体、响应体、stderr 全落 exe 同目录的文件。
    let dir = exe_dir();
    let pid = std::process::id();
    let req = dir.join(format!(".kc-req-{}.json", pid));
    let rsp = dir.join(format!(".kc-rsp-{}.json", pid));
    let errf = dir.join(format!(".kc-err-{}.txt", pid));
    std::fs::write(&req, body).map_err(|e| format!("写请求体失败: {}", e))?;
    let _ = std::fs::remove_file(&rsp);
    let ef = std::fs::File::create(&errf).map_err(|e| format!("建 stderr 文件失败: {}", e))?;
    let mut c = Command::new("curl.exe");
    c.args([
        "-s", "--max-time", "25",
        "-X", "POST", url,
        "-H", &format!("Authorization: Bearer {}", key),
        "-H", "X-Tcb-Webfn: true",
        "-H", "Content-Type: application/json",
        "--data-binary", &format!("@{}", req.to_string_lossy()),
        "-o", &rsp.to_string_lossy(),
    ])
    .stdout(Stdio::null()).stderr(Stdio::from(ef)).stdin(Stdio::null());
    no_window(&mut c);
    let st = c.status().map_err(|e| format!("curl 启动失败: {}", e));
    let _ = std::fs::remove_file(&req);
    let st = st?;
    let out = std::fs::read_to_string(&rsp).unwrap_or_default();
    let err = std::fs::read_to_string(&errf).unwrap_or_default();
    let _ = std::fs::remove_file(&rsp);
    let _ = std::fs::remove_file(&errf);
    if !st.success() {
        return Err(format!("curl 退出码 {:?}: {}", st.code(), err.trim()));
    }
    if out.trim().is_empty() {
        return Err(format!("云端返回空响应{}", if err.trim().is_empty() { String::new() } else { format!("：{}", err.trim()) }));
    }
    Ok(out)
}

fn gw_json_url(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

fn run_gateway(mut cfg: Config) {
    let dir = exe_dir();
    let key = if !cfg.api_key.is_empty() {
        cfg.api_key.clone()
    } else {
        read_trim(&dir.join(".cloudbase-apikey")).unwrap_or_default()
    };
    if key.is_empty() {
        eprintln!("没找到服务密钥（.cloudbase-apikey）。");
        eprintln!("请下载完整 zip 分发包（内含密钥文件，解压后双击\"启动快传.cmd\"即可），");
        eprintln!("或把 .cloudbase-apikey 放到本 exe 同目录 / 用 --apikey 传入。");
        return;
    }
    let code = if !cfg.device_code.is_empty() {
        cfg.device_code.clone()
    } else {
        read_trim(&dir.join(".device-code")).unwrap_or_else(gen_token)
    };
    let _ = std::fs::write(dir.join(".device-code"), &code);
    if cfg.gw_url.is_empty() {
        // 开箱即用：不带 --gw 时走项目默认网关
        cfg.gw_url = DEFAULT_GW.to_string();
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

    // 生成 6 位绑定确认码（首次启动随机；确认绑定后不再上报）
    {
        let mut cc = CONFIRM_CODE.lock().unwrap_or_else(|e| e.into_inner());
        if cc.is_empty() {
            *cc = format!("{:06}", (now_ms() as u64) % 1_000_000);
        }
        println!("  绑定确认码: {}（未绑定时在小程序「账号」页输入它完成绑定）", *cc);
    }
    println!("==============================================");

    let mut hb_agents = agents_json(&agents);
    let mut last_term_seq: u64 = 0;
    let mut last_hb: u128 = 0;
    let mut last_scan: u128 = 0;
    loop {
        // 心跳与重扫描改为时间驱动：长轮询后循环周期不再固定
        let now = now_ms();
        if now.saturating_sub(last_hb) >= 12000 {
            last_hb = now;
            if now.saturating_sub(last_scan) >= 60000 {
                last_scan = now;
                let fresh = detect_agents();
                hb_agents = agents_json(&fresh);
                println!("  [扫描] 已重新识别 {} 个智能体", fresh.len());
            }
            let lan = local_ip().unwrap_or_default();
            // 已绑定的设备不再上报确认码，让云端字段清干净
            let bound = *IS_BOUND.lock().unwrap_or_else(|e| e.into_inner());
            let cc_report = if bound {
                String::new()
            } else {
                CONFIRM_CODE.lock().unwrap_or_else(|e| e.into_inner()).clone()
            };
            let body = format!(
                "{{\"action\":\"heartbeat\",\"deviceCode\":\"{}\",\"name\":\"{}\",\"agents\":{},\"lanIp\":\"{}\",\"lanPort\":{},\"confirmCode\":\"{}\"}}",
                esc(&code), esc(&hostname()), hb_agents, esc(&lan), cfg.port, esc(&cc_report)
            );
            if let Err(e) = gw_call(&cfg.gw_url, &key, &body) {
                println!("  ! 心跳失败: {}", e);
            }
        }

        // 一次请求拉全（长轮询 15s）：命令 / 终端按键 / 智能体消息 / shell 状态。
        // 原来是 poll + agent_in + term_in + shell_get 四次串行 RTT，再固定 sleep 1200ms。
        let body = format!(
            "{{\"action\":\"sync\",\"deviceCode\":\"{}\",\"limit\":5,\"hold\":15000}}",
            esc(&code)
        );
        match gw_call(&cfg.gw_url, &key, &body) {
            Ok(resp) => {
                for d in list_objects_in(&resp, "commands") {
                    gw_handle(&cfg.gw_url, &key, &code, &cfg, &d);
                }

                // ---- 绑定状态变化提示 ----
                let now_bound = resp.contains("\"bound\":true");
                {
                    let mut was = IS_BOUND.lock().unwrap_or_else(|e| e.into_inner());
                    if *was != now_bound {
                        *was = now_bound;
                        if now_bound {
                            println!("  ✓ 设备已绑定到你的账号");
                        } else {
                            let cc = CONFIRM_CODE.lock().unwrap_or_else(|e| e.into_inner()).clone();
                            println!("  ! 设备已解绑：小程序「账号」页输入确认码 {} 重新绑定", cc);
                        }
                    }
                }

                // ---- 终端：shell 切换 / 重启 ----
                let parsed = json_str(&resp, "shell");
                let cur_shell = TERM_SHELL.lock().ok().and_then(|q| q.clone());
                if let Some(sh) = parsed {
                    match cur_shell.as_deref() {
                        // 首次读到云端值：只记住，绝不重置
                        None => {
                            if let Ok(mut g) = TERM_SHELL.lock() {
                                *g = Some(sh.clone());
                            }
                            if let Ok(guard) = TERM.lock() {
                                if guard.is_some() {
                                    let started = CUR_SHELL.lock().ok().and_then(|q| q.clone());
                                    if started.as_deref() != Some(sh.as_str()) {
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
                            let _ = ensure_term();
                        }
                        _ => {}
                    }
                }
                if let Some(ra) = json_num(&resp, "restartAt") {
                    if ra > 0 {
                        let mut last = LAST_RESTART.lock().unwrap_or_else(|e| e.into_inner());
                        if *last != ra {
                            let first = *last == 0;
                            *last = ra;
                            if !first {
                                klog("    [终端] 收到重启请求，重建会话");
                                term_reset();
                                let _ = ensure_term();
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

                // ---- Agent：拉取待发送的消息 ----
                for d in list_objects_in(&resp, "agentIn") {
                    let id = match doc_id(&d) { Some(x) => x, None => continue };
                    let text = json_str(&d, "text").unwrap_or_default();
                    let agent = json_str(&d, "agent").unwrap_or_else(|| "claude".to_string());
                    let exe = json_str(&d, "exe").unwrap_or_else(|| agent.clone());
                    if text.trim().is_empty() { continue; }

                    klog(&format!("    [agent] 收到消息 -> {}", agent));
                    // 默认 headless：一次提问拿纯文本；显式 headless=0 才走常驻会话
                    let headless = json_str(&d, "headless").unwrap_or_else(|| "1".to_string());
                    if headless != "0" {
                        let args = agent_args(&exe, &text);
                        klog(&format!("    [agent] headless: {} {:?}", exe, args));
                        let out = run_headless(&exe, &args, 150000);
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

                // ---- 终端：拉取手机端按键 ----
                for d in list_objects_in(&resp, "termIn") {
                    let id = match doc_id(&d) { Some(x) => x, None => continue };
                    let data = json_str(&d, "data").unwrap_or_default();
                    if data.is_empty() { continue; }
                    if ensure_term().is_ok() && term_write(&data).is_ok() {
                        let ack = format!("{{\"action\":\"term_ack\",\"id\":\"{}\"}}", gw_json_url(&id));
                        let _ = gw_call(&cfg.gw_url, &key, &ack);
                    }
                }
            }
            Err(e) => {
                println!("  ! 轮询失败: {}", e);
                thread::sleep(Duration::from_secs(3));
            }
        }

        // ---- 终端：推送新输出（每次循环都推，不再隔一轮）----
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
        // 不再固定 sleep 1200ms：sync 长轮询已承担等待；有数据时立刻进入下一轮
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

    // 云端来的 agent 任务：交给智能体跑，不能当 shell 命令执行
    if kind == "agent" {
        // 优先用 exe 路径判断该走哪种命令行；agent 只是显示名，作兜底
        let who = json_str(doc, "exe")
            .filter(|s| !s.trim().is_empty())
            .or_else(|| json_str(doc, "agent"))
            .unwrap_or_default();
        if who.trim().is_empty() {
            gw_update(url, key, &id, &format!(
                "{{\"status\":\"error\",\"stderr\":\"任务缺少 agent 字段\",\"finishedAt\":{}}}", now_ms()));
            println!("  ✗ agent 任务缺 agent 字段");
            return;
        }
        let args = agent_args(&who, &payload);
        klog(&format!("    [云端 agent] {} {:?}", who, args));
        println!("  ▷ {} {}", who, payload);
        // 不先回写 running：省一次云 RTT；执行中状态由小程序本地记录承担
        match run_headless(&who, &args, 180000) {
            Ok(raw) => {
                let reply = strip_ansi(&raw);
                gw_update(url, key, &id, &format!(
                    "{{\"status\":\"done\",\"stdout\":\"{}\",\"stderr\":\"\",\"exitCode\":0,\"timedOut\":false,\"finishedAt\":{}}}",
                    esc(reply.trim()), now_ms()));
                println!("  ✓ agent 完成");
            }
            Err(e) => {
                gw_update(url, key, &id, &format!(
                    "{{\"status\":\"error\",\"stderr\":\"{}\",\"finishedAt\":{}}}", esc(&e), now_ms()));
                println!("  ✗ agent 失败: {}", e);
            }
        }
        return;
    }

    println!("  $ {}", payload);

    // 全部交给常驻 Shell 顺序执行：cd / export / 环境状态都能延续，
    // 也不用再给 cd 写特判，更不会每条命令都新起一个进程。
    match term_run(&payload, cfg.timeout_ms) {
        Ok((out, xcode)) => {
            println!("    → done(exit {}) {}", xcode, out.lines().next().unwrap_or(""));
            let set = format!(
                "{{\"status\":\"{}\",\"stdout\":\"{}\",\"stderr\":\"\",\"exitCode\":{},\"ms\":0,\"timedOut\":false,\"finishedAt\":{}}}",
                if xcode == 0 { "done" } else { "error" }, esc(&out), xcode, now_ms());
            gw_update(url, key, &id, &set);
        }
        Err(e) => {
            println!("    → 失败 {}", e);
            let set = format!(
                "{{\"status\":\"error\",\"stderr\":\"{}\",\"finishedAt\":{}}}",
                esc(&e), now_ms());
            gw_update(url, key, &id, &set);
        }
    }
}

// ---------------- 常驻终端会话（Git Bash）----------------

struct TermSession {
    writer: Box<dyn std::io::Write + Send>,
    buf: std::sync::Arc<Mutex<Vec<(u64, String)>>>,
    seq: std::sync::Arc<Mutex<u64>>,
    /// 原始输出流（不是 VT 屏幕快照）。
    /// buf 是给界面看的整屏快照，只在画面变化时更新；
    /// 想让「执行一条命令再取结果」跑通，必须另有一条不丢字的通道。
    raw: std::sync::Arc<Mutex<String>>,
}

static TERM: Mutex<Option<TermSession>> = Mutex::new(None);

// 跑命令用的 Shell，和终端界面那个 ConPTY 会话分开：
// ConPTY 的输入管道写进去的命令 bash 收不到（实测），
// 而管道版 bash 能正常读命令、保留 cd/env 状态。
static TERM_EXEC: Mutex<Option<(Box<dyn std::io::Write + Send>, std::sync::Arc<Mutex<String>>)>> =
    Mutex::new(None);

/// 拿不到就建一个只有 stdin/stdout 的 bash，专门执行命令
fn ensure_exec_shell() -> Result<std::sync::Arc<Mutex<String>>, String> {
    let mut g = TERM_EXEC.lock().map_err(|_| "exec lock".to_string())?;
    if let Some((_, raw)) = g.as_ref() {
        return Ok(raw.clone());
    }
    let mut c = Command::new(bash_path());
    c.args(["--norc", "--noprofile"]);
    c.env("PS1", "");
    c.env("TERM", "dumb");
    c.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    c.creation_flags(CREATE_NO_WINDOW);
    let mut child = c.spawn().map_err(|e| format!("启动命令 Shell 失败: {}", e))?;
    let stdin = child.stdin.take().ok_or("no stdin")?;
    let out = child.stdout.take().ok_or("no stdout")?;
    let err = child.stderr.take();

    let raw: std::sync::Arc<Mutex<String>> = std::sync::Arc::new(Mutex::new(String::new()));

    let r1 = raw.clone();
    let mut o = out;
    thread::spawn(move || {
        let mut tmp = [0u8; 4096];
        loop {
            match o.read(&mut tmp) {
                Ok(0) => break,
                Ok(k) => push_raw(&r1, &String::from_utf8_lossy(&tmp[..k])),
                Err(_) => break,
            }
        }
    });
    if let Some(mut e) = err {
        let r2 = raw.clone();
        thread::spawn(move || {
            let mut tmp = [0u8; 4096];
            loop {
                match e.read(&mut tmp) {
                    Ok(0) => break,
                    Ok(k) => push_raw(&r2, &String::from_utf8_lossy(&tmp[..k])),
                    Err(_) => break,
                }
            }
        });
    }

    klog("    [term] 命令 Shell 已建立（管道）");
    let arc = raw.clone();
    *g = Some((Box::new(stdin), raw));
    Ok(arc)
}
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

/// 往原始流里追加，只保留尾部 256KB，避免长会话吃内存
fn push_raw(raw: &std::sync::Arc<Mutex<String>>, text: &str) {
    if let Ok(mut r) = raw.lock() {
        r.push_str(text);
        if r.len() > 262144 {
            let cut = r.len() - 262144;
            let cut = r.as_bytes().iter().skip(cut).position(|b| (*b & 0xC0) != 0x80).map(|i| i + cut).unwrap_or(cut);
            *r = r[cut..].to_string();
        }
    }
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

/// 在常驻 Shell 里顺序执行一条命令，返回它的输出。
///
/// 以前每条命令都新起一个进程，导致 cd/env 状态不保留，还要给 cd 写特判。
/// 现在直接写进那个唯一的 shell，用 echo 哨兵判断哪一行结束了。
fn term_run(cmd: &str, timeout_ms: u64) -> Result<(String, i32), String> {
    return term_run_pipe(cmd, timeout_ms);
}

fn term_run_pipe(cmd: &str, timeout_ms: u64) -> Result<(String, i32), String> {
    let raw = ensure_exec_shell()?;
    let token = format!("__KC_END_{}__", now_ms());
    // 记下基线：raw 是累积的，只看本次新增的部分，否则会命中上一条命令的哨兵
    let base = raw.lock().map(|r| r.len()).unwrap_or(0);
    {
        let mut g = TERM_EXEC.lock().map_err(|_| "exec lock".to_string())?;
        let (w, _) = g.as_mut().ok_or_else(|| "命令 Shell 未建立".to_string())?;
        let line = format!("{}\necho {} $?\n", cmd.trim_end_matches(['\r', '\n']), token);
        w.write_all(line.as_bytes())
            .map_err(|e| format!("写入失败: {}", e))?;
        let _ = w.flush();
    }
    let start = Instant::now();
    loop {
        if start.elapsed() > Duration::from_millis(timeout_ms) {
            return Err(format!("命令超时（{}ms）", timeout_ms));
        }
        thread::sleep(Duration::from_millis(50));
        let all = raw.lock().map(|r| r.clone()).unwrap_or_default();
        if all.len() <= base {
            continue;
        }
        let seg = &all[base..];
        if let Some(pos) = seg.rfind(&token) {
            // 非交互 bash 不回显命令，seg[..pos] 就是纯输出
            let mut s = strip_ansi(&seg[..pos]);
            if let Some(q) = s.find("__KC_END_") {
                s.truncate(q);
            }
            let code = seg[pos + token.len()..]
                .trim_start()
                .chars()
                .take_while(|c| c.is_ascii_digit())
                .collect::<String>()
                .parse::<i32>()
                .unwrap_or(0);
            return Ok((s.trim().to_string(), code));
        }
    }
}

fn term_run_legacy(cmd: &str, timeout_ms: u64) -> Result<String, String> {
    let fresh = ensure_term2()?;
    if fresh {
        // 刚拉起来的 bash 还没进入可读状态，立刻写会被吞掉。
        // 固定 sleep 靠不住（冷启动可能 2 秒），改成等它真的有输出为止。
        let probe = {
            let g = TERM.lock().map_err(|_| "term lock".to_string())?;
            g.as_ref().map(|s| s.raw.clone())
        };
        if let Some(raw) = probe {
            let t0 = Instant::now();
            loop {
                let n = raw.lock().map(|r| r.len()).unwrap_or(0);
                if n > 0 || t0.elapsed() > Duration::from_millis(8000) {
                    break;
                }
                thread::sleep(Duration::from_millis(60));
            }
            klog(&format!("    [term] shell 就绪，用时 {}ms", t0.elapsed().as_millis()));
        }
    }
    let token = format!("__KC_END_{}__", now_ms());
    let buf = {
        let mut g = TERM.lock().map_err(|_| "term lock".to_string())?;
        let s = g.as_mut().ok_or_else(|| "终端未建立".to_string())?;
        let line = format!("{}\necho {}\n", cmd.trim_end_matches(['\r', '\n']), token);
        s.writer
            .write_all(line.as_bytes())
            .map_err(|e| format!("写入失败: {}", e))?;
        let _ = s.writer.flush();
        s.raw.clone()
    };

    let start = Instant::now();
    loop {
        if start.elapsed() > Duration::from_millis(timeout_ms) {
            return Err(format!("命令超时（{}ms）", timeout_ms));
        }
        thread::sleep(Duration::from_millis(100));

        let all: String = {
            let r = buf.lock().map_err(|_| "raw lock".to_string())?;
            r.clone()
        };
        if let Some(pos) = all.rfind(&token) {
            let head = &all[..pos];
            // 去掉命令本身被回显的那一段
            let body = match head.rfind(cmd.trim()) {
                Some(i) => &head[i + cmd.trim().len()..],
                None => head,
            };
            // 原始流里，哨兵那行 echo 的残影落在输出之后，直接在那儿截断
            let mut s = strip_ansi(body);
            if let Some(q) = s.find("__KC_END_") {
                s.truncate(q);
            }
            if let Some(q) = s.rfind("$ echo") {
                s.truncate(q);
            }
            return Ok(s.trim().to_string());
        }
    }
}

// 默认：管道版 bash（无 TTY，但普通命令都能跑）
fn ensure_term() -> Result<(), String> { ensure_term2().map(|_| ()) }

/// 同 ensure_term，但告诉调用方这次是不是刚新建的会话
fn ensure_term2() -> Result<bool, String> {
    let mut g = TERM.lock().map_err(|e| format!("term lock 中毒: {}", e))?;
    if g.is_some() {
        klog("    [term] ensure_term: 复用已有会话");
        return Ok(false);
    }
    klog("    [term] ensure_term: 当前无会话，准备新建");

    let use_pty = env::var("KC_PTY").map(|v| v != "0").unwrap_or(true);

    let buf: std::sync::Arc<Mutex<Vec<(u64, String)>>> = std::sync::Arc::new(Mutex::new(Vec::new()));
    let seq: std::sync::Arc<Mutex<u64>> = std::sync::Arc::new(Mutex::new(0));
    let raw: std::sync::Arc<Mutex<String>> = std::sync::Arc::new(Mutex::new(String::new()));

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
                    return ensure_term2();
                }
            };

            let mut reader = p.reader;
            let b = buf.clone();
            let s = seq.clone();
            let rawbuf = raw.clone();
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

                            let chunk = String::from_utf8_lossy(&tmp[..n]).to_string();
                            push_raw(&rawbuf, &chunk); // 原始流：给命令执行用
                            // 先灌进屏幕网格，只有画面变化时推整屏快照
                            if let Some(snap) = vt_feed(my_gen, &chunk) {
                                push_chunk(&b, &s, snap);
                            }
                        }
                        Err(e) => { klog(&format!("    [pty] 读取错误: {}", e)); break; }
                    }
                }
            });
            *g = Some(TermSession { writer: Box::new(p.writer), buf, seq, raw });
            klog(&format!("    [终端] ConPTY 会话已建立 (pid {})", p.pid));
            return Ok(true);
        }
        #[cfg(not(windows))]
        return Err("ConPTY 仅支持 Windows".into());
    }

    // headless 退路：不要 -i。
    // 交互模式在拿不到 tty 时会报 "cannot set terminal process group" /
    // "no job control"，而且读到 EOF 就退出，常驻会话根本立不住。
    // 非交互 bash 会从 stdin 逐行读命令、执行、把输出写到 stdout，
    // 只要写端不关就一直活着 —— 正是 term_run 需要的。
    let mut c = Command::new(bash_path());
    c.args(["--norc", "--noprofile"]);
    c.env("PS1", "");
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
    let r1 = raw.clone();
    let mut o = out;
    thread::spawn(move || {
        let mut tmp = [0u8; 4096];
        loop {
            match o.read(&mut tmp) {
                Ok(0) => break,
                Ok(n) => {
                    let c = String::from_utf8_lossy(&tmp[..n]).to_string();
                    push_raw(&r1, &c);
                    push_chunk(&b1, &s1, c);
                }
                Err(_) => break,
            }
        }
    });

    if let Some(mut e) = err {
        let b2 = buf.clone();
        let s2 = seq.clone();
        let r2 = raw.clone();
        thread::spawn(move || {
            let mut tmp = [0u8; 4096];
            loop {
                match e.read(&mut tmp) {
                    Ok(0) => break,
                    Ok(n) => {
                        let c = String::from_utf8_lossy(&tmp[..n]).to_string();
                        push_raw(&r2, &c);
                        push_chunk(&b2, &s2, c);
                    }
                    Err(_) => break,
                }
            }
        });
    }

    *g = Some(TermSession { writer: Box::new(stdin), buf, seq, raw });
    println!("    [终端] bash 管道会话已建立（无 TTY）");
    Ok(true)
}

/// 关闭当前会话，下次 ensure_term 会用 TERM_SHELL 里记着的 shell 重建。
/// 注意：这里【不能】清 TERM_SHELL，否则轮询会一直判定「云端设置 != 当前」而无限重置。
fn term_reset() {
    klog("    [term] term_reset 被调用（会话将被丢弃）");
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
/// 按智能体类型构造「单次提问 → 纯文本」的参数
///
/// 各家的非交互入口都不一样，而且都有坑：
///   DSH    : headless 是 profile 名，要写 --profile headless
///   Claude : -p/--print + --output-format text，permission-mode 用 dontAsk 免得卡在确认
///   Codex  : exec 要 --skip-git-repo-check（否则非 git 目录直接报错）
///   Hermes : -z/--oneshot，只打印最终文本
fn agent_args(exe: &str, text: &str) -> Vec<String> {
    let e = exe.to_lowercase();
    let name = Path::new(exe)
        .file_name()
        .map(|s| s.to_string_lossy().to_lowercase())
        .unwrap_or_default();

    if name.contains("dsh") || e.contains("deepseek") {
        vec!["--profile".into(), "headless".into(), text.to_string()]
    } else if name.contains("claude") {
        // 只有模型名显式给出时才传 --model，否则沿用用户自己的配置
        let mut v = vec![
            "-p".to_string(),
            text.to_string(),
            "--output-format".into(), "text".into(),
            "--permission-mode".into(), "dontAsk".into(),
        ];
        if let Ok(m) = env::var("KC_CLAUDE_MODEL") {
            if !m.trim().is_empty() {
                v.push("--model".into());
                v.push(m);
            }
        }
        v
    } else if name.contains("codex") {
        vec!["exec".into(), "--skip-git-repo-check".into(), text.to_string()]
    } else if name.contains("hermes") {
        vec!["-z".into(), text.to_string()]
    } else if name.contains("ollama") {
        vec!["run".into(), text.to_string()]
    } else {
        vec![text.to_string()]
    }
}
/// 直接跑一个进程并拿到它的 stdout（非交互模式，用于 headless agent）
fn run_headless(exe: &str, args: &[String], timeout_ms: u64) -> Result<String, String> {
    // 先按老办法：.cmd 直接解析出 bin.js 用 node 跑（快、无中间层）。
    // 失败就退回 cmd.exe /c 跑原始 shim —— 有些 shim 会设置环境变量，
    // 绕过去会导致程序行为异常（DSH 就是这样，写 profile 时报 EPERM）。
    match run_headless_direct(exe, args, timeout_ms) {
        Ok(v) => Ok(v),
        Err(e) => {
            let lc = exe.to_lowercase();
            if lc.ends_with(".cmd") || lc.ends_with(".bat") {
                match run_headless_shim(exe, args, timeout_ms) {
                    Ok(v) => Ok(v),
                    Err(_) => Err(e),
                }
            } else {
                Err(e)
            }
        }
    }
}

fn run_headless_shim(exe: &str, args: &[String], timeout_ms: u64) -> Result<String, String> {
    // 用 cmd.exe 跑原始 shim，保留它内部设的环境变量
    let mut c = Command::new("cmd.exe");
    c.arg("/c").arg(exe);
    c.args(args);
    c.stdin(Stdio::null());
    c.stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    c.creation_flags(CREATE_NO_WINDOW);
    collect_child(c, timeout_ms)
}

fn collect_child(mut c: Command, timeout_ms: u64) -> Result<String, String> {
    let mut child = c.spawn().map_err(|e| format!("启动失败: {}", e))?;
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

fn run_headless_direct(exe: &str, args: &[String], timeout_ms: u64) -> Result<String, String> {
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

/// 设备绑定确认码：未绑定时显示在控制台并随心跳上报，小程序「账号」页输码完成绑定
static CONFIRM_CODE: Mutex<String> = Mutex::new(String::new());
/// 绑定状态（由 sync 响应的 bound 字段驱动，用于状态变化提示与停止上报确认码）
static IS_BOUND: Mutex<bool> = Mutex::new(false);

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
        pub fn AttachConsole(pid: u32) -> i32;
        pub fn CreateFileA(n: *const u8, acc: u32, share: u32, sec: *mut core::ffi::c_void, disp: u32, fl: u32, tmpl: Handle) -> Handle;
        pub fn SetStdHandle(kind: u32, h: Handle) -> i32;
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


#[cfg(test)]
mod cfg_tests {
    use super::*;

    #[test]
    fn mask_hides_secret_values() {
        let orig = "{\n  \"env\": {\n    \"ANTHROPIC_AUTH_TOKEN\": \"sk-abc123\",\n    \"MODEL\": \"foo\"\n  }\n}";
        let masked = mask_secrets(orig);
        assert!(masked.contains(MASK), "应该出现占位符");
        assert!(!masked.contains("sk-abc123"), "真实密钥不能出现在输出里");
        assert!(masked.contains("foo"), "非敏感值要原样保留");
    }

    #[test]
    fn restore_puts_secret_back() {
        let orig = "{\n  \"env\": {\n    \"ANTHROPIC_AUTH_TOKEN\": \"sk-abc123\",\n    \"MODEL\": \"foo\"\n  }\n}";
        let masked = mask_secrets(orig);
        let restored = restore_masked(&masked, orig);
        assert!(restored.contains("sk-abc123"), "写回时密钥必须还原");
        assert!(!restored.contains(MASK), "不能把占位符写进文件");
        assert!(restored.contains("foo"));
    }

    #[test]
    fn restore_keeps_user_edit() {
        // 用户把 model 改了，密钥仍要被还原
        let orig = "{\n  \"ANTHROPIC_AUTH_TOKEN\": \"sk-abc123\",\n  \"MODEL\": \"old\"\n}";
        let masked = mask_secrets(orig);
        let edited = masked.replace("\"old\"", "\"new\"");
        let restored = restore_masked(&edited, orig);
        assert!(restored.contains("sk-abc123"), "密钥要还原");
        assert!(restored.contains("\"new\""), "用户的修改要保留");
        assert!(!restored.contains("\"old\""));
    }

    #[test]
    fn plain_text_untouched() {
        let s = "# 只是注释\n没有等号也没有冒号的一行\n";
        assert_eq!(mask_secrets(s), s);
    }
}
