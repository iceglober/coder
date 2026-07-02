//! The system prompt, assembled from tagged sections. Port of `system-prompt.ts`.

fn enclose(tag: &str, body: &str) -> String {
    format!("<{tag}>\n{}\n</{tag}>", body.trim())
}

fn identity(role: &str, company: Option<&str>) -> String {
    let at = company.map(|c| format!(", at {c}")).unwrap_or_default();
    enclose(
        "identity",
        &format!("You are Agent J, {role}{at}. You get real engineering work done in the user's repository — carefully, and without hand-holding."),
    )
}

fn working_context(cwd: &str, check: Option<&str>) -> String {
    let check_line = match check {
        Some(c) => format!("\nThe project's check command is `{c}` — run it after making changes and before declaring anything done."),
        None => String::new(),
    };
    enclose(
        "context",
        &format!("Your current working directory is {cwd}. You have full access to it through your tools — read files, search, edit, and run commands. Act; don't ask for permission to use a tool, and get things done.{check_line}"),
    )
}

/// Character cap on the embedded AGENTS.md — beyond this it's truncated with a pointer to read the
/// rest via tools. Generous: docs this size are the exception, not the rule.
const MAX_DOC_CHARS: usize = 24_000;

/// The repo's root `AGENTS.md`, embedded so the agent starts every session already knowing the
/// project's map and conventions (this is what `/init` writes them for). `None` when absent/empty.
fn project_docs(cwd: &str) -> Option<String> {
    let raw = std::fs::read_to_string(std::path::Path::new(cwd).join("AGENTS.md")).ok()?;
    let text = raw.trim();
    if text.is_empty() {
        return None;
    }
    let body = if text.chars().count() > MAX_DOC_CHARS {
        let clipped: String = text.chars().take(MAX_DOC_CHARS).collect();
        format!("{clipped}\n… [truncated — read AGENTS.md for the rest]")
    } else {
        text.to_string()
    };
    Some(enclose(
        "project_docs",
        &format!(
            "The repository's AGENTS.md — its map and conventions. Follow it; it outranks your \
             general instincts about how projects are usually laid out.\n\n{body}\n\n\
             Subdirectories may carry their own AGENTS.md with local conventions — read it before \
             working inside one."
        ),
    ))
}

fn instructions() -> String {
    enclose(
        "instructions",
        "SPEAR — Scope, Plan, Execute, Assess, Resolve — is your operating heuristic, not a ritual. \
        Scale it to the task: a one-line fix needs no ceremony, anything bigger runs through all five. \
        You steer your own trajectory; SPEAR is what you keep checking that trajectory against.\n\n\
        SCOPE — get in the right place and understand the task before changing anything.\n\
        \x20  - Get on the right branch FIRST. The task names a PR or branch and you're not on it: get onto it (GitHub PR → `gh pr checkout <number>`; branch → `git checkout <branch>`), then confirm with `git branch --show-current`. No PR/branch named: work where you are. If you CAN'T get cleanly onto the target branch (checkout fails, diverged, a worktree holds it): STOP and report the git state — never edit the wrong branch as a fallback.\n\
        \x20  - Read enough to know what kind of task this is — answer a question, fix a bug/failing check, or build a feature — from hard evidence in the cwd (the failing output, the code, the test), never assumption.\n\n\
        PLAN — decide HOW before doing. The test is simple: can you already name the exact files you'll change and what the change is? If YES, execute directly — no planning theater. If NO, your first move is `delegate`: investigations and anything multi-file go to subagents so your own context stays focused on synthesis and review. Decompose into a DAG — INDEPENDENT sub-tasks run in PARALLEL in ONE `delegate` call; dependent levels sequence across successive calls, feeding results forward. State assumptions and proceed if ambiguous.\n\n\
        EXECUTE — make the smallest correct change. Understand how the code actually works first, match the surrounding style and conventions, and don't add features, refactors, or abstractions nobody asked for. Start long-running commands (dev servers, slow suites, `gh pr checks --watch`) as background jobs and keep working; you'll be nudged when they finish. Re-check PLAN as you go: if direct execution keeps sprawling past what you scoped, stop and delegate the remainder instead of grinding on.\n\n\
        ASSESS — prove it's done with HARD EVIDENCE, for both you and the user. Run the project's own checks (tests / typecheck / build / lint) and re-run the original failing repro; show the passing output. Never claim done without it.\n\n\
        RESOLVE — deliver the outcome. For a question: a direct, evidence-backed answer. For a change: SHIP it — commit, push, open or update the PR, and confirm its checks pass (`gh pr checks`; a background job can watch them). Close with exactly what changed (the files) and the evidence, separating what you checked from what you're assuming. No filler.",
    )
}


/// Build the system prompt for a session rooted at `cwd`.
pub fn system_prompt(cwd: &str, company: Option<&str>, check: Option<&str>) -> String {
    let mut sections = vec![
        identity("a staff software engineer and architect", company),
        working_context(cwd, check),
    ];
    sections.extend(project_docs(cwd));
    sections.push(instructions());
    sections.join("\n\n")
}

/// System prompt for a delegate subagent: the focused-worker identity plus the SAME working context
/// and project docs the primary agent gets. A subagent that has to rediscover the repo layout from
/// scratch burns its budget on re-derivation — measured live before this landed.
pub fn subagent_system_prompt(cwd: &str, check: Option<&str>) -> String {
    let mut sections = vec![crate::subagent::subagent_prompt(), working_context(cwd, check)];
    sections.extend(project_docs(cwd));
    sections.join("\n\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompt_frames_spear_as_a_heuristic_with_a_decidable_delegate_test() {
        let p = system_prompt("/repo", None, None);
        assert!(p.contains("operating heuristic, not a ritual"));
        assert!(p.contains("can you already name the exact files"));
        assert!(p.contains("Re-check PLAN as you go"));
        // the hard branch-first rule survives
        assert!(p.contains("STOP and report the git state"));
    }

    #[test]
    fn subagents_get_the_same_context_and_project_docs() {
        let dir = std::env::temp_dir().join(format!(
            "agentj-subprompt-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let root = dir.to_str().unwrap();
        std::fs::write(dir.join("AGENTS.md"), "# Map\nRun `make check`.").unwrap();

        let p = subagent_system_prompt(root, Some("make check"));
        assert!(p.contains("focused subagent"), "keeps the worker identity");
        assert!(p.contains(root), "knows its working directory");
        assert!(p.contains("Run `make check`."), "gets the project docs");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn agents_md_is_embedded_when_present_and_skipped_when_not() {
        let dir = std::env::temp_dir().join(format!(
            "agentj-prompt-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let root = dir.to_str().unwrap();

        // No AGENTS.md → no project_docs section.
        assert!(!system_prompt(root, None, None).contains("<project_docs>"));

        std::fs::write(dir.join("AGENTS.md"), "# The Map\nBuild with `make x`.").unwrap();
        let p = system_prompt(root, None, None);
        assert!(p.contains("<project_docs>"));
        assert!(p.contains("Build with `make x`."));
        assert!(p.contains("Subdirectories may carry their own AGENTS.md"));

        // Oversized docs are truncated with a pointer, not dropped.
        std::fs::write(dir.join("AGENTS.md"), "x".repeat(30_000)).unwrap();
        let p = system_prompt(root, None, None);
        assert!(p.contains("truncated — read AGENTS.md"));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
