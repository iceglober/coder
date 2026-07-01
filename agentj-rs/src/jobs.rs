//! Background jobs. `job_start` spawns a long-running command (dev server, slow suite,
//! `gh pr checks --watch`) in its own process group and returns immediately — agentj keeps working.
//! When a job finishes, or its fallback timeout fires, a **nudge** is queued; the loop injects ready
//! nudges as user messages and idle-waits for one only when it has nothing else to do (see agent.rs).

use nix::sys::signal::{kill, Signal};
use nix::unistd::Pid;
use std::collections::{HashMap, VecDeque};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::sync::{Mutex, Notify};

const OUTPUT_CAP: usize = 16 * 1024; // per-job captured-output ceiling (keep the tail)

#[derive(Clone, Copy, PartialEq)]
enum JobStatus {
    Running,
    Exited(i32),
}

struct JobHandle {
    command: String,
    state: Mutex<JobState>,
}

struct JobState {
    status: JobStatus,
    output: String,
    pid: Option<i32>,
}

fn tail(s: &str, n: usize) -> String {
    let lines: Vec<&str> = s.lines().collect();
    let start = lines.len().saturating_sub(n);
    lines[start..].join("\n")
}

pub struct JobManager {
    root: String,
    jobs: Mutex<HashMap<u64, Arc<JobHandle>>>,
    next_id: AtomicU64,
    /// Queued finished/timed-out nudges. A plain `Mutex` — never held across `.await`.
    nudges: Arc<std::sync::Mutex<VecDeque<String>>>,
    /// Wakes an idle `next_nudge` when a nudge is queued.
    notify: Arc<Notify>,
    /// Count of jobs that haven't exited yet, so `has_running` is O(1) and lock-free.
    running: Arc<AtomicUsize>,
}

/// Queue a nudge and wake any idle waiter. Free function so the spawned tasks can call it with just
/// the shared handles, without borrowing the whole manager.
fn push_nudge(nudges: &std::sync::Mutex<VecDeque<String>>, notify: &Notify, msg: String) {
    nudges.lock().unwrap().push_back(msg);
    notify.notify_one();
}

impl JobManager {
    pub fn new(root: String) -> Arc<Self> {
        Arc::new(Self {
            root,
            jobs: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            nudges: Arc::new(std::sync::Mutex::new(VecDeque::new())),
            notify: Arc::new(Notify::new()),
            running: Arc::new(AtomicUsize::new(0)),
        })
    }

    /// Start `command` in the background; returns its id immediately. `timeout` (if set) fires a
    /// single "still running" nudge after that long.
    pub async fn start(&self, command: &str, timeout: Option<Duration>) -> anyhow::Result<u64> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let mut child = Command::new("bash")
            .arg("-lc")
            .arg(command)
            .current_dir(&self.root)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0)
            .spawn()?;
        let pid = child.id().map(|p| p as i32);
        let handle = Arc::new(JobHandle {
            command: command.to_string(),
            state: Mutex::new(JobState {
                status: JobStatus::Running,
                output: String::new(),
                pid,
            }),
        });
        self.jobs.lock().await.insert(id, handle.clone());
        self.running.fetch_add(1, Ordering::Relaxed);

        // Stream stdout + stderr into the capped buffer.
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        for pipe in [stdout.map(Pipe::Out), stderr.map(Pipe::Err)]
            .into_iter()
            .flatten()
        {
            let h = handle.clone();
            tokio::spawn(async move {
                let mut reader = pipe.into_inner();
                let mut buf = [0u8; 4096];
                loop {
                    match reader.read(&mut buf).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            let mut st = h.state.lock().await;
                            st.output.push_str(&String::from_utf8_lossy(&buf[..n]));
                            let over = st.output.len().saturating_sub(OUTPUT_CAP);
                            if over > 0 {
                                st.output = st.output.split_off(over);
                            }
                        }
                    }
                }
            });
        }

        // Wait for exit → nudge (and drop the running count).
        let name = command.chars().take(40).collect::<String>();
        let h = handle.clone();
        let nudges = self.nudges.clone();
        let notify = self.notify.clone();
        let running = self.running.clone();
        let exit_name = name.clone();
        tokio::spawn(async move {
            let code = child.wait().await.ok().and_then(|s| s.code()).unwrap_or(-1);
            let out_tail = {
                let mut st = h.state.lock().await;
                st.status = JobStatus::Exited(code);
                tail(&st.output, 20)
            };
            running.fetch_sub(1, Ordering::Relaxed);
            push_nudge(
                &nudges,
                &notify,
                format!("[job {id} `{exit_name}` finished, exit {code}]\n{out_tail}"),
            );
        });

        // Fallback timeout → one "still running" nudge.
        if let Some(t) = timeout {
            let h = handle.clone();
            let nudges = self.nudges.clone();
            let notify = self.notify.clone();
            tokio::spawn(async move {
                tokio::time::sleep(t).await;
                if matches!(h.state.lock().await.status, JobStatus::Running) {
                    push_nudge(
                        &nudges,
                        &notify,
                        format!(
                            "[job {id} `{name}` still running after {}s — job_check it or move on]",
                            t.as_secs()
                        ),
                    );
                }
            });
        }
        Ok(id)
    }

    /// Whether any job hasn't exited yet. O(1) — called on every idle loop iteration.
    pub fn has_running(&self) -> bool {
        self.running.load(Ordering::Relaxed) > 0
    }

    /// Ready nudges (finished jobs / fired timeouts), non-blocking.
    pub fn drain_nudges(&self) -> Vec<String> {
        self.nudges.lock().unwrap().drain(..).collect()
    }

    /// Await the next nudge (used to idle-wait when the model has nothing else to do). The notified
    /// future is armed before the queue is re-checked, so a nudge queued in the gap isn't lost.
    pub async fn next_nudge(&self) -> String {
        loop {
            let notified = self.notify.notified();
            if let Some(n) = self.nudges.lock().unwrap().pop_front() {
                return n;
            }
            notified.await;
        }
    }

    /// Status + output tail for one job (or all).
    pub async fn check(&self, id: Option<u64>) -> String {
        let jobs = self.jobs.lock().await;
        let mut out = Vec::new();
        let mut ids: Vec<u64> = jobs.keys().copied().collect();
        ids.sort_unstable();
        for jid in ids {
            if let Some(want) = id {
                if jid != want {
                    continue;
                }
            }
            let h = &jobs[&jid];
            let st = h.state.lock().await;
            let status = match st.status {
                JobStatus::Running => "running".to_string(),
                JobStatus::Exited(c) => format!("exited {c}"),
            };
            let cmd = h.command.chars().take(60).collect::<String>();
            out.push(format!(
                "job {jid} [{status}] `{cmd}`\n{}",
                tail(&st.output, 15)
            ));
        }
        if out.is_empty() {
            "no matching jobs".to_string()
        } else {
            out.join("\n---\n")
        }
    }

    pub async fn stop(&self, id: u64) -> String {
        let jobs = self.jobs.lock().await;
        match jobs.get(&id) {
            Some(h) => {
                if let Some(pid) = h.state.lock().await.pid {
                    let _ = kill(Pid::from_raw(-pid), Signal::SIGKILL);
                }
                format!("stopped job {id}")
            }
            None => format!("no job {id}"),
        }
    }

    /// The id the next started job will get. Capture before spawning a turn; anything `>=` this later
    /// was started by that turn.
    pub fn id_watermark(&self) -> u64 {
        self.next_id.load(Ordering::Relaxed)
    }

    /// SIGKILL every still-running job whose id is `>= watermark` — the jobs an interrupted turn
    /// started, without touching jobs from earlier turns.
    pub async fn kill_after(&self, watermark: u64) {
        for (id, h) in self.jobs.lock().await.iter() {
            if *id >= watermark {
                let st = h.state.lock().await;
                if matches!(st.status, JobStatus::Running) {
                    if let Some(pid) = st.pid {
                        let _ = kill(Pid::from_raw(-pid), Signal::SIGKILL);
                    }
                }
            }
        }
    }

    /// Kill every still-running job (session teardown).
    pub async fn kill_all(&self) {
        for h in self.jobs.lock().await.values() {
            let st = h.state.lock().await;
            if matches!(st.status, JobStatus::Running) {
                if let Some(pid) = st.pid {
                    let _ = kill(Pid::from_raw(-pid), Signal::SIGKILL);
                }
            }
        }
    }
}

/// Small helper so both pipes share one reader body.
enum Pipe {
    Out(tokio::process::ChildStdout),
    Err(tokio::process::ChildStderr),
}
impl Pipe {
    fn into_inner(self) -> Box<dyn tokio::io::AsyncRead + Unpin + Send> {
        match self {
            Pipe::Out(o) => Box::new(o),
            Pipe::Err(e) => Box::new(e),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn finish_nudge_carries_output_and_exit() {
        let mgr = JobManager::new(".".to_string());
        let id = mgr.start("echo hello; exit 3", None).await.unwrap();
        // Wait for the finish nudge.
        let nudge = mgr.next_nudge().await;
        assert!(nudge.contains(&format!("job {id}")));
        assert!(nudge.contains("exit 3"));
        assert!(nudge.contains("hello"));
        assert!(!mgr.has_running());
    }

    #[tokio::test]
    async fn timeout_nudge_fires_for_a_slow_job() {
        let mgr = JobManager::new(".".to_string());
        let id = mgr
            .start("sleep 5", Some(Duration::from_millis(100)))
            .await
            .unwrap();
        // First nudge should be the timeout one (job still running).
        let nudge = mgr.next_nudge().await;
        assert!(nudge.contains("still running"));
        assert!(mgr.has_running());
        mgr.stop(id).await;
    }

    #[tokio::test]
    async fn kill_after_spares_jobs_below_the_watermark() {
        let mgr = JobManager::new(".".to_string());
        let old = mgr.start("sleep 5", None).await.unwrap();
        let watermark = mgr.id_watermark(); // captured "at turn start"
        let new = mgr.start("sleep 5", None).await.unwrap();
        assert!(new >= watermark && old < watermark);

        mgr.kill_after(watermark).await;
        // the newer job is killed; its exit nudge arrives
        let nudge = mgr.next_nudge().await;
        assert!(nudge.contains(&format!("job {new}")));
        // the older job is still running
        assert!(mgr.has_running());
        mgr.stop(old).await;
    }
}
