//! The agent's tools: read/write/edit/ls/glob/grep/bash. Port of `tools.ts`. Confined to `root` via
//! `safe_resolve`; auto-permission; tools return a string, never error out of the call.

use crate::exec::run;
use crate::jobs::JobManager;
use crate::mcp::client::McpClients;
use crate::provider::ToolSpec;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

const BASH_TIMEOUT: Duration = Duration::from_secs(120);

/// A tool result. `text` is what the model sees (tools never error out of a call, per convention);
/// `ok` is a structural success flag the UI uses to mark failed calls, decided at the source instead
/// of re-sniffed from the string.
pub struct ToolOutcome {
    pub text: String,
    pub ok: bool,
}

impl ToolOutcome {
    pub(crate) fn ok(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            ok: true,
        }
    }
    pub(crate) fn err(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            ok: false,
        }
    }
}

pub struct Tools {
    pub root: PathBuf,
    pub jobs: Arc<JobManager>,
    pub mcp: Option<Arc<McpClients>>,
}

fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        format!("{}…", s.chars().take(max).collect::<String>())
    }
}

fn head_tail(text: &str, head: usize, tail: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= head + tail {
        return text.to_string();
    }
    let omitted = chars.len() - head - tail;
    let h: String = chars[..head].iter().collect();
    let t: String = chars[chars.len() - tail..].iter().collect();
    format!("{h}\n… [{omitted} chars omitted] …\n{t}")
}

/// Resolve `rel` against `root` and confine it there (rejects `..` / symlink escapes), even when the
/// target doesn't exist yet (write_file).
fn safe_resolve(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let real_root = fs::canonicalize(root).map_err(|e| e.to_string())?;
    let abs = real_root.join(rel);
    let mut existing = abs.clone();
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    while !existing.exists() {
        match existing.file_name() {
            Some(name) => tail.push(name.to_os_string()),
            None => break,
        }
        match existing.parent() {
            Some(p) => existing = p.to_path_buf(),
            None => break,
        }
    }
    let mut final_path = fs::canonicalize(&existing).map_err(|e| e.to_string())?;
    for seg in tail.iter().rev() {
        final_path.push(seg);
    }
    if !final_path.starts_with(&real_root) {
        return Err(format!("path escapes the repo root: {rel}"));
    }
    Ok(final_path)
}

fn arg_str<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key).and_then(|v| v.as_str())
}

impl Tools {
    pub fn new(root: PathBuf, jobs: Arc<JobManager>, mcp: Option<Arc<McpClients>>) -> Self {
        Self { root, jobs, mcp }
    }

    /// Tool specs contributed by connected MCP servers (each `<server>__<tool>`).
    pub fn mcp_specs(&self) -> Vec<ToolSpec> {
        self.mcp.as_ref().map(|m| m.specs()).unwrap_or_default()
    }

    fn root_str(&self) -> String {
        self.root.to_string_lossy().into_owned()
    }

    pub async fn call(&self, name: &str, args: &Value) -> ToolOutcome {
        match name {
            "read_file" => self.read_file(args),
            "write_file" => self.write_file(args),
            "edit_file" => self.edit_file(args),
            "list_dir" => self.list_dir(args),
            "glob" => self.glob(args).await,
            "grep" => self.grep(args).await,
            "bash" => self.bash(args).await,
            "web_check" => crate::webcheck::web_check(&self.root, args).await,
            "job_start" => self.job_start(args).await,
            "job_check" => ToolOutcome::ok(
                self.jobs
                    .check(args.get("id").and_then(|v| v.as_u64()))
                    .await,
            ),
            "job_stop" => match args.get("id").and_then(|v| v.as_u64()) {
                Some(id) => ToolOutcome::ok(self.jobs.stop(id).await),
                None => ToolOutcome::err("error: job_stop needs an id"),
            },
            other => match &self.mcp {
                Some(mcp) if mcp.has_tool(other) => {
                    let (text, ok) = mcp.call(other, args).await;
                    ToolOutcome { text, ok }
                }
                _ => ToolOutcome::err(format!("error: unknown tool `{other}`")),
            },
        }
    }

    async fn job_start(&self, args: &Value) -> ToolOutcome {
        let command = match arg_str(args, "command") {
            Some(c) => c,
            None => return ToolOutcome::err("error: job_start needs a command"),
        };
        let timeout = args
            .get("timeout_s")
            .and_then(|v| v.as_u64())
            .map(Duration::from_secs);
        match self.jobs.start(command, timeout).await {
            Ok(id) => ToolOutcome::ok(format!(
                "started job {id} in the background — keep working; you'll be nudged when it finishes{}.",
                timeout.map(|t| format!(" or after {}s", t.as_secs())).unwrap_or_default()
            )),
            Err(e) => ToolOutcome::err(format!("error: {e}")),
        }
    }

    fn read_file(&self, args: &Value) -> ToolOutcome {
        let path = match arg_str(args, "path") {
            Some(p) => p,
            None => return ToolOutcome::err("error: read_file needs a path"),
        };
        let abs = match safe_resolve(&self.root, path) {
            Ok(a) => a,
            Err(e) => return ToolOutcome::err(format!("error: {e}")),
        };
        let bytes = match fs::read(&abs) {
            Ok(b) => b,
            Err(_) => return ToolOutcome::err(format!("file not found: {path}")),
        };
        if bytes.is_empty() {
            return ToolOutcome::ok("(empty file)");
        }
        if bytes.iter().take(8000).any(|&b| b == 0) {
            return ToolOutcome::ok(format!("[binary file, {} bytes, not shown]", bytes.len()));
        }
        let text = String::from_utf8_lossy(&bytes);
        let lines: Vec<&str> = text.split('\n').collect();
        let total = lines.len();
        let offset = args
            .get("offset")
            .and_then(|v| v.as_u64())
            .unwrap_or(1)
            .max(1) as usize;
        let limit = args
            .get("limit")
            .and_then(|v| v.as_u64())
            .unwrap_or(400)
            .clamp(1, 1200) as usize;
        if offset > total {
            return ToolOutcome::err(format!(
                "{path}: {total} lines; offset {offset} is past the end"
            ));
        }
        let end = (offset - 1 + limit).min(total);
        let numbered: String = lines[offset - 1..end]
            .iter()
            .enumerate()
            .map(|(i, l)| format!("{}\t{}", offset + i, l))
            .collect::<Vec<_>>()
            .join("\n");
        let note = if offset > 1 || end < total {
            format!("\n[lines {offset}–{end} of {total}; pass offset/limit for more]")
        } else {
            String::new()
        };
        ToolOutcome::ok(format!("{}{}", clip(&numbered, 40_000), note))
    }

    fn write_file(&self, args: &Value) -> ToolOutcome {
        let (path, content) = match (arg_str(args, "path"), arg_str(args, "content")) {
            (Some(p), Some(c)) => (p, c),
            _ => return ToolOutcome::err("error: write_file needs path and content"),
        };
        let abs = match safe_resolve(&self.root, path) {
            Ok(a) => a,
            Err(e) => return ToolOutcome::err(format!("error: {e}")),
        };
        if let Some(parent) = abs.parent() {
            let _ = fs::create_dir_all(parent);
        }
        match fs::write(&abs, content) {
            Ok(_) => ToolOutcome::ok(format!("wrote {} bytes to {path}", content.len())),
            Err(e) => ToolOutcome::err(format!("error: {e}")),
        }
    }

    fn edit_file(&self, args: &Value) -> ToolOutcome {
        let (path, old, new) = match (
            arg_str(args, "path"),
            arg_str(args, "old_string"),
            arg_str(args, "new_string"),
        ) {
            (Some(p), Some(o), Some(n)) => (p, o, n),
            _ => return ToolOutcome::err("error: edit_file needs path, old_string, new_string"),
        };
        let abs = match safe_resolve(&self.root, path) {
            Ok(a) => a,
            Err(e) => return ToolOutcome::err(format!("error: {e}")),
        };
        let text = match fs::read_to_string(&abs) {
            Ok(t) => t,
            Err(_) => return ToolOutcome::err(format!("file not found: {path}")),
        };
        let count = text.matches(old).count();
        if count == 0 {
            return ToolOutcome::err(format!(
                "old_string not found in {path} — re-read the file; it may have changed since you last saw it"
            ));
        }
        let replace_all = args
            .get("replace_all")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        if count > 1 && !replace_all {
            return ToolOutcome::err(format!(
                "old_string is not unique in {path} ({count} matches) — add more context, or pass replace_all to replace every occurrence"
            ));
        }
        let updated = if replace_all {
            text.replace(old, new)
        } else {
            text.replacen(old, new, 1)
        };
        match fs::write(&abs, updated) {
            Ok(_) => ToolOutcome::ok(if replace_all {
                format!(
                    "edited {path} ({count} replacement{})",
                    if count == 1 { "" } else { "s" }
                )
            } else {
                format!("edited {path}")
            }),
            Err(e) => ToolOutcome::err(format!("error: {e}")),
        }
    }

    fn list_dir(&self, args: &Value) -> ToolOutcome {
        let path = arg_str(args, "path").unwrap_or(".");
        let abs = match safe_resolve(&self.root, path) {
            Ok(a) => a,
            Err(e) => return ToolOutcome::err(format!("error: {e}")),
        };
        let entries = match fs::read_dir(&abs) {
            Ok(e) => e,
            Err(e) => return ToolOutcome::err(format!("error: {e}")),
        };
        let mut names: Vec<String> = entries
            .filter_map(|e| e.ok())
            .map(|e| {
                let n = e.file_name().to_string_lossy().into_owned();
                if e.path().is_dir() {
                    format!("{n}/")
                } else {
                    n
                }
            })
            .collect();
        names.sort();
        if names.is_empty() {
            ToolOutcome::ok("(empty)")
        } else {
            ToolOutcome::ok(clip(&names.join("\n"), 8000))
        }
    }

    async fn glob(&self, args: &Value) -> ToolOutcome {
        let pattern = match arg_str(args, "pattern") {
            Some(p) => p,
            None => return ToolOutcome::err("error: glob needs a pattern"),
        };
        if pattern.starts_with('/') || pattern.split('/').any(|s| s == "..") {
            return ToolOutcome::err(
                "error: pattern must stay within the repo (no leading / or '..')",
            );
        }
        let norm = if pattern.contains('/') {
            pattern.to_string()
        } else {
            format!("**/{pattern}")
        };
        let matcher = match glob::Pattern::new(&norm) {
            Ok(m) => m,
            Err(e) => return ToolOutcome::err(format!("error: {e}")),
        };
        // Respect .gitignore via git ls-files; fall back to a filesystem walk.
        let mut hits: Vec<String> = Vec::new();
        if let Ok(o) = run(
            &[
                "git",
                "ls-files",
                "--cached",
                "--others",
                "--exclude-standard",
            ],
            &self.root_str(),
            None,
        )
        .await
        {
            if o.exit_code == 0 {
                for f in o.stdout.lines().filter(|l| !l.is_empty()) {
                    if matcher.matches(f) {
                        hits.push(f.to_string());
                    }
                }
            }
        }
        if hits.is_empty() {
            let root_glob = format!("{}/{}", self.root_str(), norm);
            if let Ok(paths) = glob::glob(&root_glob) {
                for p in paths.flatten() {
                    if let Ok(rel) = p.strip_prefix(&self.root) {
                        let rel = rel.to_string_lossy();
                        if !rel.starts_with("node_modules/") && !rel.starts_with(".git/") {
                            hits.push(rel.into_owned());
                        }
                    }
                }
            }
        }
        hits.sort();
        hits.dedup();
        if hits.is_empty() {
            return ToolOutcome::ok("no matches");
        }
        let shown: String = hits
            .iter()
            .take(100)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n");
        if hits.len() > 100 {
            ToolOutcome::ok(format!("{shown}\n… (+{} more)", hits.len() - 100))
        } else {
            ToolOutcome::ok(shown)
        }
    }

    async fn grep(&self, args: &Value) -> ToolOutcome {
        let pattern = match arg_str(args, "pattern") {
            Some(p) => p,
            None => return ToolOutcome::err("error: grep needs a pattern"),
        };
        // An empty path arg means "search the whole repo", not an empty (invalid) path.
        let where_ = match arg_str(args, "path") {
            Some(p) if !p.is_empty() => p,
            _ => ".",
        };
        if let Err(e) = safe_resolve(&self.root, where_) {
            return ToolOutcome::err(format!("error: {e}"));
        }
        let root = self.root_str();
        let (out, err, code) = match run(
            &[
                "rg",
                "--line-number",
                "--no-heading",
                "--color",
                "never",
                pattern,
                where_,
            ],
            &root,
            None,
        )
        .await
        {
            Ok(o) => (o.stdout, o.stderr, o.exit_code),
            Err(_) => match run(
                &["git", "grep", "-n", "-E", pattern, "--", where_],
                &root,
                None,
            )
            .await
            {
                Ok(o) => (o.stdout, o.stderr, o.exit_code),
                Err(e) => return ToolOutcome::err(format!("error: {e}")),
            },
        };
        // rg/git-grep exit 0 = matches, 1 = no matches; anything else is a real error (invalid
        // regex, unreadable path). Surface it so the model doesn't read it as "no matches".
        if code != 0 && code != 1 {
            let detail: String = err.lines().take(3).collect::<Vec<_>>().join("\n");
            return ToolOutcome::err(if detail.trim().is_empty() {
                format!("search failed (exit {code})")
            } else {
                format!("search failed: {detail}")
            });
        }
        if code == 1 || out.trim().is_empty() {
            return ToolOutcome::ok("no matches");
        }
        let lines: Vec<&str> = out.lines().filter(|l| !l.is_empty()).collect();
        let shown = lines
            .iter()
            .take(50)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n");
        if lines.len() > 50 {
            ToolOutcome::ok(format!("{shown}\n… (+{} more matches)", lines.len() - 50))
        } else {
            ToolOutcome::ok(shown)
        }
    }

    async fn bash(&self, args: &Value) -> ToolOutcome {
        let command = match arg_str(args, "command") {
            Some(c) => c,
            None => return ToolOutcome::err("error: bash needs a command"),
        };
        // Optional per-call timeout, clamped to 1..=600s; falls back to the default.
        let timeout = args
            .get("timeout_s")
            .and_then(|v| v.as_u64())
            .map(|s| Duration::from_secs(s.clamp(1, 600)))
            .unwrap_or(BASH_TIMEOUT);
        match run(&["bash", "-lc", command], &self.root_str(), Some(timeout)).await {
            Ok(o) => {
                let raw: String = [o.stdout.trim_end(), o.stderr.trim_end()]
                    .iter()
                    .filter(|s| !s.is_empty())
                    .cloned()
                    .collect::<Vec<_>>()
                    .join("\n");
                let note = if o.timed_out {
                    format!("\n[timed out after {}s]", timeout.as_secs())
                } else {
                    String::new()
                };
                // The command ran — a non-zero exit is a normal result, not a tool failure.
                ToolOutcome::ok(
                    format!(
                        "{}\n[exit {}]{}",
                        head_tail(&raw, 4000, 2000),
                        o.exit_code,
                        note
                    )
                    .trim()
                    .to_string(),
                )
            }
            Err(e) => ToolOutcome::err(format!("error: {e}")),
        }
    }
}

/// Tool specs advertised to the model (OpenAI function-calling schemas). `delegate` is included only
/// for the primary loop (`allow_delegate`), so subagents can't fan out recursively.
pub fn tool_specs(allow_delegate: bool) -> Vec<ToolSpec> {
    let mut specs = vec![
        ToolSpec {
            name: "read_file".into(),
            description: "Read a UTF-8 text file (relative to repo root), returned with line numbers. Pass offset/limit (1-based) for a span.".into(),
            parameters: json!({ "type": "object", "properties": { "path": { "type": "string" }, "offset": { "type": "number" }, "limit": { "type": "number" } }, "required": ["path"] }),
        },
        ToolSpec {
            name: "write_file".into(),
            description: "Create or overwrite a file with the given content.".into(),
            parameters: json!({ "type": "object", "properties": { "path": { "type": "string" }, "content": { "type": "string" } }, "required": ["path", "content"] }),
        },
        ToolSpec {
            name: "edit_file".into(),
            description: "Replace an exact, unique string in a file. old_string must occur exactly once, unless replace_all is set — then every occurrence is replaced and the count reported.".into(),
            parameters: json!({ "type": "object", "properties": { "path": { "type": "string" }, "old_string": { "type": "string" }, "new_string": { "type": "string" }, "replace_all": { "type": "boolean", "description": "replace every occurrence of old_string instead of requiring it be unique" } }, "required": ["path", "old_string", "new_string"] }),
        },
        ToolSpec {
            name: "list_dir".into(),
            description: "List the entries of a directory (relative to repo root). Directories end with /.".into(),
            parameters: json!({ "type": "object", "properties": { "path": { "type": "string" } } }),
        },
        ToolSpec {
            name: "glob".into(),
            description: "Find files by glob pattern relative to the repo root (e.g. '**/*.rs', 'README*'). Respects .gitignore.".into(),
            parameters: json!({ "type": "object", "properties": { "pattern": { "type": "string" } }, "required": ["pattern"] }),
        },
        ToolSpec {
            name: "grep".into(),
            description: "Search file contents with a regex from the repo root. Returns matching lines with line numbers.".into(),
            parameters: json!({ "type": "object", "properties": { "pattern": { "type": "string" }, "path": { "type": "string" } }, "required": ["pattern"] }),
        },
        ToolSpec {
            name: "bash".into(),
            description: "Run a shell command from the repo root (bash -lc). Use for builds, tests, git, etc. Output truncated; bounded to 120s by default, or `timeout_s` (1..=600) if given.".into(),
            parameters: json!({ "type": "object", "properties": { "command": { "type": "string" }, "timeout_s": { "type": "number", "description": "kill the command after this many seconds (clamped to 1..=600; default 120)" } }, "required": ["command"] }),
        },
        ToolSpec {
            name: "web_check".into(),
            description: "Verify a running web page in a real headless browser (you cannot see it otherwise). Loads `url` and reports what's invisible from the source: uncaught exceptions, console.error output, failed network requests (>=400), and — if given — whether `expect_text` appears or `expect_selector` exists. Use this to check FRONTEND/UI work after starting the dev server (job_start), the way you'd run tests for backend work. ok=false on any error or failed assertion. Needs `bun` + Playwright + a Chrome/Chromium.".into(),
            parameters: json!({ "type": "object", "properties": {
                "url": { "type": "string", "description": "page to load, e.g. http://localhost:5173" },
                "wait_for": { "type": "string", "description": "optional CSS selector to wait for before checking" },
                "expect_text": { "type": "string", "description": "optional: assert this text is visible on the page" },
                "expect_selector": { "type": "string", "description": "optional: assert an element matching this CSS selector exists" },
                "timeout_s": { "type": "number", "description": "navigation timeout seconds (default 15)" }
            }, "required": ["url"] }),
        },
        ToolSpec {
            name: "job_start".into(),
            description: "Start a long-running command in the BACKGROUND (dev server, slow test suite, `gh pr checks --watch`). Returns a job id immediately — keep working on other things. You'll be nudged when it finishes, or after `timeout_s` if it's still running. Prefer this over `bash` for anything slow.".into(),
            parameters: json!({ "type": "object", "properties": { "command": { "type": "string" }, "timeout_s": { "type": "number", "description": "fallback: nudge you if the job is still running after this many seconds" } }, "required": ["command"] }),
        },
        ToolSpec {
            name: "job_check".into(),
            description: "Check background jobs — status (running/exited) + recent output. Omit `id` for all jobs. Non-blocking.".into(),
            parameters: json!({ "type": "object", "properties": { "id": { "type": "number" } } }),
        },
        ToolSpec {
            name: "job_stop".into(),
            description: "Kill a background job by id.".into(),
            parameters: json!({ "type": "object", "properties": { "id": { "type": "number" } }, "required": ["id"] }),
        },
    ];
    if allow_delegate {
        specs.push(ToolSpec {
            name: "delegate".into(),
            description: "Delegate one or more sub-tasks to subagents that each run in their OWN context and return a concise result. Use for any sub-task you expect to take more than ~5 tool calls (investigations, multi-file changes) — it keeps YOUR context small. INDEPENDENT sub-tasks passed in one call run in PARALLEL; sequence dependent work across separate `delegate` calls, feeding results forward. Each result comes back labeled `[subagent i]`.".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "tasks": {
                        "type": "array",
                        "description": "One or more independent sub-tasks to run in parallel.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "task": { "type": "string", "description": "The self-contained sub-task instruction." },
                                "title": { "type": "string", "description": "A short 3–8 word label for this sub-task, shown in the UI while it runs (e.g. 'Map the Rust crate')." },
                                "context": { "type": "string", "description": "Optional extra context (paths, findings) the subagent needs." }
                            },
                            "required": ["task"]
                        }
                    }
                },
                "required": ["tasks"]
            }),
        });
    }
    specs
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jobs::JobManager;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn tools() -> Tools {
        Tools::new(PathBuf::from("."), JobManager::new(".".to_string()), None)
    }

    static TEMP_COUNTER: AtomicUsize = AtomicUsize::new(0);

    /// A `Tools` rooted at a fresh temp dir, so file-mutating tests don't touch the crate tree.
    fn temp_tools() -> (Tools, PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "agentj-tools-test-{}-{}",
            std::process::id(),
            TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&dir).unwrap();
        let jm = JobManager::new(dir.to_string_lossy().into_owned());
        (Tools::new(dir.clone(), jm, None), dir)
    }

    #[tokio::test]
    async fn unknown_tool_reports_not_ok() {
        let o = tools().call("no_such_tool", &json!({})).await;
        assert!(!o.ok);
        assert!(o.text.contains("unknown tool"));
    }

    #[tokio::test]
    async fn missing_required_arg_reports_not_ok() {
        let o = tools().call("read_file", &json!({})).await;
        assert!(!o.ok);
    }

    #[tokio::test]
    async fn reading_a_missing_file_reports_not_ok() {
        let o = tools()
            .call("read_file", &json!({ "path": "definitely-not-here.xyz" }))
            .await;
        assert!(!o.ok);
    }

    #[tokio::test]
    async fn reading_an_existing_file_is_ok() {
        // the crate manifest is always present when tests run from the crate root
        let o = tools().call("read_file", &json!({ "path": "Cargo.toml" })).await;
        assert!(o.ok, "expected ok, got: {}", o.text);
    }

    #[tokio::test]
    async fn grep_invalid_regex_reports_failure() {
        // An unmatched '(' is invalid for both rg and git grep; the tool must not read the
        // resulting non-1 exit code as "no matches".
        let o = tools().call("grep", &json!({ "pattern": "(" })).await;
        assert!(!o.ok, "expected failure, got ok: {}", o.text);
        assert!(
            o.text.to_ascii_lowercase().contains("fail"),
            "expected a failure message, got: {}",
            o.text
        );
    }

    #[tokio::test]
    async fn grep_empty_path_searches_the_repo() {
        // Empty path must behave like "." (whole repo), not error out.
        let o = tools()
            .call("grep", &json!({ "pattern": "fn ", "path": "" }))
            .await;
        assert!(o.ok, "expected ok, got: {}", o.text);
    }

    #[tokio::test]
    async fn bash_honors_timeout_s() {
        let o = tools()
            .call("bash", &json!({ "command": "sleep 5", "timeout_s": 1 }))
            .await;
        assert!(
            o.text.contains("timed out"),
            "expected a timeout note, got: {}",
            o.text
        );
    }

    #[tokio::test]
    async fn edit_file_replace_all_replaces_every_occurrence() {
        let (t, dir) = temp_tools();
        fs::write(dir.join("f.txt"), "a a a").unwrap();
        let o = t
            .call(
                "edit_file",
                &json!({ "path": "f.txt", "old_string": "a", "new_string": "b", "replace_all": true }),
            )
            .await;
        assert!(o.ok, "expected ok, got: {}", o.text);
        assert!(o.text.contains('3'), "expected a count of 3, got: {}", o.text);
        assert_eq!(fs::read_to_string(dir.join("f.txt")).unwrap(), "b b b");
    }

    #[tokio::test]
    async fn edit_file_not_unique_suggests_replace_all() {
        let (t, dir) = temp_tools();
        fs::write(dir.join("f.txt"), "a a a").unwrap();
        let o = t
            .call(
                "edit_file",
                &json!({ "path": "f.txt", "old_string": "a", "new_string": "b" }),
            )
            .await;
        assert!(!o.ok);
        assert!(
            o.text.contains("replace_all"),
            "expected a replace_all hint, got: {}",
            o.text
        );
    }

    #[tokio::test]
    async fn edit_file_not_found_suggests_reread() {
        let (t, dir) = temp_tools();
        fs::write(dir.join("f.txt"), "hello").unwrap();
        let o = t
            .call(
                "edit_file",
                &json!({ "path": "f.txt", "old_string": "nope", "new_string": "x" }),
            )
            .await;
        assert!(!o.ok);
        assert!(
            o.text.contains("re-read"),
            "expected a re-read hint, got: {}",
            o.text
        );
    }
}
