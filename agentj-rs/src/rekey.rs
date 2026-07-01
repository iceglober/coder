//! Long-running-worktree re-key for `/task`. Port of `rekey.ts`. Deterministic git sequence: discard
//! everything, fetch, and re-point the worktree at a clean base from origin.

use crate::exec::run;
use std::path::Path;
use std::time::Duration;

pub struct RekeyResult {
    pub ok: bool,
    pub branch: Option<String>,
    pub steps: Vec<String>,
    pub error: Option<String>,
}

/// A linked worktree's `.git` is a FILE (a `gitdir:` pointer); the primary checkout's is a directory.
pub fn is_linked_worktree(root: &str) -> bool {
    std::fs::metadata(Path::new(root).join(".git"))
        .map(|m| m.is_file())
        .unwrap_or(false)
}

/// All-digits ref → a PR number; anything else → a branch name.
pub fn is_pr(reference: &str) -> bool {
    !reference.is_empty() && reference.bytes().all(|b| b.is_ascii_digit())
}

fn first_line(s: &str) -> String {
    s.lines()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("")
        .trim()
        .to_string()
}

/// Wipe the worktree, fetch, and re-key onto `reference` — a clean base from origin. Never panics.
pub async fn rekey(root: &str, reference: &str) -> RekeyResult {
    let mut steps: Vec<String> = Vec::new();
    let git = |argv: Vec<&'static str>, args_owned: Vec<String>, timeout: Option<Duration>| {
        // Build argv from static + owned parts, run, and record a step line.
        async move {
            let owned_refs: Vec<&str> = args_owned.iter().map(|s| s.as_str()).collect();
            let full: Vec<&str> = argv.into_iter().chain(owned_refs.into_iter()).collect();
            let r = run(&full, root, timeout).await;
            match r {
                Ok(o) => {
                    let mut line = full.join(" ");
                    if o.exit_code != 0 {
                        let msg = if !first_line(&o.stderr).is_empty() {
                            first_line(&o.stderr)
                        } else {
                            first_line(&o.stdout)
                        };
                        line = format!("{line} — exit {}: {msg}", o.exit_code);
                    }
                    (line, Some(o))
                }
                Err(e) => (format!("{} — spawn error: {e}", full.join(" ")), None),
            }
        }
    };

    // 1. Discard everything from the previous task.
    let (l, _) = git(vec!["git", "reset", "--hard"], vec![], None).await;
    steps.push(l);
    let (l, _) = git(vec!["git", "clean", "-fd"], vec![], None).await;
    steps.push(l);

    // 2. Sync origin.
    let (l, o) = git(
        vec!["git", "fetch", "origin"],
        vec![],
        Some(Duration::from_secs(60)),
    )
    .await;
    steps.push(l);
    if o.as_ref().map(|o| o.exit_code != 0).unwrap_or(true) {
        return RekeyResult {
            ok: false,
            branch: None,
            steps,
            error: Some("git fetch origin failed".into()),
        };
    }

    // 3. Re-key onto the target from a clean origin base.
    if is_pr(reference) {
        let (l, o) = git(
            vec!["gh", "pr", "checkout"],
            vec![reference.to_string()],
            Some(Duration::from_secs(60)),
        )
        .await;
        steps.push(l);
        if o.as_ref().map(|o| o.exit_code != 0).unwrap_or(true) {
            return RekeyResult {
                ok: false,
                branch: None,
                steps,
                error: Some(format!("gh pr checkout {reference} failed")),
            };
        }
        let branch = run(&["git", "branch", "--show-current"], root, None)
            .await
            .map(|o| o.stdout.trim().to_string())
            .unwrap_or_default();
        return RekeyResult {
            ok: true,
            branch: Some(if branch.is_empty() {
                reference.to_string()
            } else {
                branch
            }),
            steps,
            error: None,
        };
    }

    // Branch: track origin/<ref> if it exists, else a new branch off origin/main.
    let on_origin = run(
        &[
            "git",
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("refs/remotes/origin/{reference}"),
        ],
        root,
        None,
    )
    .await
    .map(|o| o.exit_code == 0)
    .unwrap_or(false);
    let base = if on_origin {
        format!("origin/{reference}")
    } else {
        "origin/main".to_string()
    };
    let (l, o) = git(
        vec!["git", "checkout", "-B"],
        vec![reference.to_string(), base.clone()],
        None,
    )
    .await;
    steps.push(l);
    if o.as_ref().map(|o| o.exit_code != 0).unwrap_or(true) {
        return RekeyResult {
            ok: false,
            branch: None,
            steps,
            error: Some(format!("git checkout -B {reference} {base} failed")),
        };
    }
    RekeyResult {
        ok: true,
        branch: Some(reference.to_string()),
        steps,
        error: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ref_classification() {
        assert!(is_pr("2720"));
        assert!(!is_pr("main"));
        assert!(!is_pr("feat/x"));
        assert!(!is_pr(""));
    }
}
