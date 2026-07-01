//! Command runner — runs in its own process group so a timeout/abort kills the whole tree, not just
//! the shell. Port of `exec.ts`. Never errors on a non-zero exit; that's a normal result.

use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::process::Command;

pub struct CommandOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
    pub timed_out: bool,
}

/// Kill a whole process group by pid (negative pid → the group), mirroring `process.kill(-pid)`.
fn kill_group(pid: i32) {
    use nix::sys::signal::{kill, Signal};
    use nix::unistd::Pid;
    let _ = kill(Pid::from_raw(-pid), Signal::SIGKILL);
}

pub async fn run(
    argv: &[&str],
    cwd: &str,
    timeout: Option<Duration>,
) -> anyhow::Result<CommandOutput> {
    let mut cmd = Command::new(argv[0]);
    cmd.args(&argv[1..])
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0) // its own group leader → we can kill the whole tree
        .kill_on_drop(true);
    let mut child = cmd.spawn()?;
    let pid = child.id().map(|p| p as i32);

    // Drain stdout/stderr concurrently so a full pipe can't deadlock the child. The pipes are always
    // present (we set `Stdio::piped()` above), but tolerate their absence rather than panic.
    let out = child.stdout.take();
    let err = child.stderr.take();
    let out_task = tokio::spawn(async move {
        let mut buf = Vec::new();
        if let Some(mut out) = out {
            let _ = out.read_to_end(&mut buf).await;
        }
        buf
    });
    let err_task = tokio::spawn(async move {
        let mut buf = Vec::new();
        if let Some(mut err) = err {
            let _ = err.read_to_end(&mut buf).await;
        }
        buf
    });

    let mut timed_out = false;
    let status = match timeout {
        Some(dur) => match tokio::time::timeout(dur, child.wait()).await {
            Ok(s) => s?,
            Err(_) => {
                timed_out = true;
                if let Some(p) = pid {
                    kill_group(p);
                }
                child.wait().await?
            }
        },
        None => child.wait().await?,
    };

    let stdout = String::from_utf8_lossy(&out_task.await.unwrap_or_default()).into_owned();
    let stderr = String::from_utf8_lossy(&err_task.await.unwrap_or_default()).into_owned();
    let exit_code = status.code().unwrap_or(if timed_out { 137 } else { 143 });
    Ok(CommandOutput {
        stdout,
        stderr,
        exit_code,
        timed_out,
    })
}
