//! Exercises the REAL host binary as a subprocess.
//!
//! The unit tests cover the pieces; this covers the thing that ships. It matters
//! here more than usual because the push channel is the one part of actuation whose
//! failure mode is silence: if the pump thread never starts, or the registration ack
//! is relayed to Chrome as though it were an action, or two threads interleave
//! frames on stdout, every unit test still passes and no action ever arrives.
//!
//! What is NOT covered here is Chrome itself. These tests speak Chrome's
//! length-prefixed native-messaging protocol to the host's stdio, which is exactly
//! what Chrome does, but a real `connectNative` port is not in the loop.

use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

const EXTENSION_ID: &str = "ndgljknidknbakdjbhebbhlhclafngil";

fn host_binary() -> std::path::PathBuf {
    // Sibling of the test binary: target/<profile>/deps/<test> → target/<profile>/
    let mut path = std::env::current_exe().expect("test exe");
    path.pop();
    if path.ends_with("deps") {
        path.pop();
    }
    path.join("maman-browser-host")
}

struct Harness {
    child: Child,
    listener: UnixListener,
    _dir: TempDir,
}

/// A directory that removes itself, so a failed test leaves no stray socket.
struct TempDir(std::path::PathBuf);
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn start(test_name: &str) -> Harness {
    let dir = std::env::temp_dir().join(format!("maman-relay-{test_name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("temp dir");
    let socket = dir.join("browser-host.sock");
    let listener = UnixListener::bind(&socket).expect("bind fake desktop socket");

    let child = Command::new(host_binary())
        .arg(format!("chrome-extension://{EXTENSION_ID}/"))
        .env("MAMAN_BROWSER_HOST_SOCKET", &socket)
        .env("MAMAN_ALLOWED_EXTENSION_IDS", EXTENSION_ID)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn host: run `cargo build` in native/browser-host first");

    Harness {
        child,
        listener,
        _dir: TempDir(dir),
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Harness {
    fn send(&mut self, value: &serde_json::Value) {
        let stdin = self.child.stdin.as_mut().expect("stdin");
        let bytes = serde_json::to_vec(value).expect("serialize");
        stdin
            .write_all(&(bytes.len() as u32).to_le_bytes())
            .expect("write length");
        stdin.write_all(&bytes).expect("write body");
        stdin.flush().expect("flush");
    }

    /// Reads one length-prefixed frame from the host's stdout.
    fn recv(&mut self) -> serde_json::Value {
        let stdout = self.child.stdout.as_mut().expect("stdout");
        let mut len = [0u8; 4];
        stdout.read_exact(&mut len).expect("frame length");
        let mut body = vec![0u8; u32::from_le_bytes(len) as usize];
        stdout.read_exact(&mut body).expect("frame body");
        serde_json::from_slice(&body).expect("frame is JSON")
    }

    /// Accepts the host's persistent connection and reads its registration line.
    fn accept_registration(&self) -> (UnixStream, serde_json::Value) {
        let (stream, _) = self.listener.accept().expect("host connected");
        let mut reader = BufReader::new(stream.try_clone().expect("clone"));
        let mut line = String::new();
        reader.read_line(&mut line).expect("registration line");
        let register: serde_json::Value = serde_json::from_str(&line).expect("registration JSON");
        (stream, register)
    }
}

fn push(stream: &mut UnixStream, value: &serde_json::Value) {
    let line = serde_json::to_string(value).expect("serialize");
    stream
        .write_all(format!("{line}\n").as_bytes())
        .expect("push");
    stream.flush().expect("flush");
}

#[test]
fn relay_open_registers_with_the_desktop_and_pushes_reach_chrome() {
    let mut h = start("push");
    h.send(&serde_json::json!({
        "type": "relay_open",
        "installation_id": "install-1",
    }));

    // The host connected to the desktop and identified the extension.
    let (mut desktop, register) = h.accept_registration();
    assert_eq!(register["type"], "relay_register");
    assert_eq!(register["installation_id"], "install-1");

    // The ack the desktop sends must be CONSUMED by the pump, not forwarded to
    // Chrome as if it were an action to perform.
    push(&mut desktop, &serde_json::json!({"ok": true}));

    // Chrome sees the reply to its own relay_open...
    let reply = h.recv();
    assert_eq!(reply["ok"], true);

    // ...and then the pushed request, and nothing in between.
    let envelope = serde_json::json!({
        "message_id": "m1",
        "installation_id": "install-1",
        "timestamp": "2026-08-05T12:00:00.000Z",
        "nonce": "n1",
        "payload": {"type": "browser_action_request", "request": {"step_id": "step-1"}},
        "signature": "deadbeef",
    });
    push(&mut desktop, &envelope);
    assert_eq!(h.recv(), envelope);
}

#[test]
fn many_pushes_arrive_in_order_and_intact() {
    let mut h = start("order");
    h.send(&serde_json::json!({"type": "relay_open", "installation_id": "install-1"}));
    let (mut desktop, _) = h.accept_registration();
    push(&mut desktop, &serde_json::json!({"ok": true})); // ack
    assert_eq!(h.recv()["ok"], true);

    // Enough frames that an unsynchronised stdout would be likely to interleave.
    for n in 0..25 {
        push(&mut desktop, &serde_json::json!({"seq": n, "pad": "x".repeat(200)}));
    }
    for n in 0..25 {
        let got = h.recv();
        assert_eq!(got["seq"], n, "frame {n} arrived out of order or corrupted");
        assert_eq!(got["pad"].as_str().map(str::len), Some(200));
    }
}

#[test]
fn a_relay_open_without_an_installation_id_is_refused() {
    let mut h = start("no-id");
    h.send(&serde_json::json!({"type": "relay_open"}));
    let reply = h.recv();
    assert_eq!(reply["ok"], false);
    assert_eq!(reply["error"], "missing installation_id");
}

#[test]
fn a_relay_open_reports_a_desktop_that_is_not_listening() {
    // A socket path with nothing bound: the host must say so rather than hang.
    let dir = std::env::temp_dir().join(format!("maman-relay-down-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("temp dir");
    let guard = TempDir(dir.clone());

    let mut child = Command::new(host_binary())
        .arg(format!("chrome-extension://{EXTENSION_ID}/"))
        .env("MAMAN_BROWSER_HOST_SOCKET", dir.join("absent.sock"))
        .env("MAMAN_ALLOWED_EXTENSION_IDS", EXTENSION_ID)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn host");

    {
        let stdin = child.stdin.as_mut().expect("stdin");
        let bytes =
            serde_json::to_vec(&serde_json::json!({"type": "relay_open", "installation_id": "i"}))
                .unwrap();
        stdin.write_all(&(bytes.len() as u32).to_le_bytes()).unwrap();
        stdin.write_all(&bytes).unwrap();
        stdin.flush().unwrap();
    }

    let stdout = child.stdout.as_mut().expect("stdout");
    let mut len = [0u8; 4];
    stdout.read_exact(&mut len).expect("frame length");
    let mut body = vec![0u8; u32::from_le_bytes(len) as usize];
    stdout.read_exact(&mut body).expect("frame body");
    let reply: serde_json::Value = serde_json::from_slice(&body).unwrap();

    assert_eq!(reply["ok"], false);
    assert!(
        reply["error"]
            .as_str()
            .unwrap_or_default()
            .contains("desktop core unavailable"),
        "unexpected error: {reply}"
    );

    let _ = child.kill();
    let _ = child.wait();
    drop(guard);
}

#[test]
fn a_denied_origin_never_opens_a_channel() {
    let dir = std::env::temp_dir().join(format!("maman-relay-denied-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("temp dir");
    let guard = TempDir(dir.clone());
    let socket = dir.join("browser-host.sock");
    let listener = UnixListener::bind(&socket).expect("bind");
    listener
        .set_nonblocking(true)
        .expect("nonblocking so a missing connection is not a hang");

    let mut child = Command::new(host_binary())
        .arg("chrome-extension://someotherextensionidaaaaaaaaaaaa/")
        .env("MAMAN_BROWSER_HOST_SOCKET", &socket)
        .env("MAMAN_ALLOWED_EXTENSION_IDS", EXTENSION_ID)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn host");

    let stdout = child.stdout.as_mut().expect("stdout");
    let mut len = [0u8; 4];
    stdout.read_exact(&mut len).expect("frame length");
    let mut body = vec![0u8; u32::from_le_bytes(len) as usize];
    stdout.read_exact(&mut body).expect("frame body");
    let reply: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(reply["error"], "origin_denied");

    // The origin check happens before the read loop, so no registration can occur.
    let deadline = Instant::now() + Duration::from_millis(300);
    while Instant::now() < deadline {
        match listener.accept() {
            Ok(_) => panic!("a denied origin opened a push channel"),
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(e) => panic!("accept failed: {e}"),
        }
    }

    let _ = child.kill();
    let _ = child.wait();
    drop(guard);
}
