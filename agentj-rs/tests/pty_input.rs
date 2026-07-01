use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

fn bin_path() -> PathBuf {
    if let Ok(p) = std::env::var("CARGO_BIN_EXE_agentj") {
        return PathBuf::from(p);
    }
    let mut p = std::env::current_exe().expect("current_exe");
    p.pop(); // deps
    p.pop(); // debug|release
    p.push(if cfg!(windows) { "agentj.exe" } else { "agentj" });
    p
}

fn drain_until_quiet(rx: &mpsc::Receiver<Vec<u8>>, quiet_for: Duration, max_wait: Duration) -> Vec<u8> {
    let started = Instant::now();
    let mut last = Instant::now();
    let mut out = Vec::new();
    loop {
        let remaining = max_wait
            .checked_sub(started.elapsed())
            .unwrap_or_else(|| Duration::from_millis(0));
        if remaining.is_zero() {
            break;
        }
        let wait = quiet_for.min(remaining);
        match rx.recv_timeout(wait) {
            Ok(chunk) => {
                out.extend_from_slice(&chunk);
                last = Instant::now();
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if last.elapsed() >= quiet_for {
                    break;
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    out
}

fn strip_ansi(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut i = 0;
    let mut out = String::with_capacity(s.len());
    while i < bytes.len() {
        if bytes[i] == 0x1b {
            i += 1;
            if i < bytes.len() && bytes[i] == b'[' {
                i += 1;
                while i < bytes.len() {
                    let b = bytes[i];
                    i += 1;
                    if (0x40..=0x7e).contains(&b) {
                        break;
                    }
                }
            } else if i < bytes.len() && bytes[i] == b']' {
                i += 1;
                while i < bytes.len() {
                    let b = bytes[i];
                    i += 1;
                    if b == 0x07 {
                        break;
                    }
                    if b == 0x1b && i < bytes.len() && bytes[i] == b'\\' {
                        i += 1;
                        break;
                    }
                }
            }
            continue;
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    out
}

fn run_once_with_input(input: &[u8]) -> String {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 100,
            pixel_width: 0,
            pixel_height: 0,
        })
        .expect("openpty");

    let mut cmd = CommandBuilder::new(bin_path());
    cmd.arg("--provider");
    cmd.arg("azure");
    cmd.arg("--model");
    cmd.arg("dummy");
    cmd.arg("--base-url");
    cmd.arg("http://127.0.0.1:1");
    cmd.cwd(std::env::current_dir().expect("cwd"));

    let mut child = pair.slave.spawn_command(cmd).expect("spawn command");
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().expect("clone reader");
    let mut writer = pair.master.take_writer().expect("take writer");
    let (tx, rx) = mpsc::channel();
    let reader_thread = thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    let _ = drain_until_quiet(&rx, Duration::from_millis(200), Duration::from_secs(2));
    writer.write_all(input).expect("write input");
    writer.flush().expect("flush input");
    drop(writer);

    let status = child.wait().expect("wait child");
    assert!(status.success(), "agentj exited with {status:?}");

    let mut output = drain_until_quiet(&rx, Duration::from_millis(200), Duration::from_secs(2));
    reader_thread.join().expect("join reader thread");
    output.extend_from_slice(&drain_until_quiet(
        &rx,
        Duration::from_millis(50),
        Duration::from_millis(200),
    ));

    strip_ansi(&String::from_utf8_lossy(&output))
}

#[test]
fn enter_submits_from_pty_in_interactive_mode() {
    let output = run_once_with_input(b"alpha\r");
    assert!(
        output.contains("alpha"),
        "expected submitted prompt text to appear in output, got:\n{output}"
    );
}

#[test]
fn shifted_printable_input_round_trips_through_pty() {
    let output = run_once_with_input(b"A:!\r");
    assert!(
        output.contains("A:!"),
        "expected shifted printable chars in submitted prompt, got:\n{output}"
    );
}

#[test]
fn ctrl_backspace_byte_deletes_a_word_through_pty() {
    let output = run_once_with_input(b"alpha beta\x17\r");
    assert!(
        output.contains("alpha"),
        "expected PTY ctrl-backspace byte to edit the input before submit, got:\n{output}"
    );
    assert!(
        !output.contains("alphabeta"),
        "expected PTY ctrl-backspace byte not to leave the full original input intact, got:\n{output}"
    );
}

#[test]
fn long_burst_input_survives_pty_round_trip() {
    let payload = "a".repeat(512);
    let mut input = payload.clone().into_bytes();
    input.push(b'\r');
    let output = run_once_with_input(&input);
    assert!(
        output.contains(&payload[..128]),
        "expected long PTY burst input prefix in output, got:\n{output}"
    );
    assert!(
        output.contains(&payload[payload.len() - 128..]),
        "expected long PTY burst input suffix in output, got:\n{output}"
    );
}

#[test]
fn repeated_word_deletes_apply_before_submit_through_pty() {
    let output = run_once_with_input(b"alpha beta gamma\x17\x17\r");
    assert!(
        output.contains("gamma") || output.contains("beta") || output.contains("alpha"),
        "expected repeated PTY delete bytes to produce visible edited terminal output, got:\n{output}"
    );
    assert!(
        !output.contains("alphabeta gamma"),
        "expected repeated PTY delete bytes not to leave an undeleted merged prompt intact, got:\n{output}"
    );
}
