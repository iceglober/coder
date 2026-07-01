//! Interactive slash commands — one registry shared by the input line (highlight + Tab completion)
//! and the chat loop (dispatch). Port of `commands.ts` + the pure helpers from `input.ts`.

#[derive(Debug, Clone, Copy)]
pub struct SlashCommand {
    /// Including the leading slash, e.g. "/task".
    pub name: &'static str,
    /// Whether the command expects an argument (Tab completes it with a trailing space).
    pub takes_arg: bool,
    /// One line shown when Tab lists ambiguous matches.
    pub summary: &'static str,
}

pub const SLASH_COMMANDS: &[SlashCommand] = &[
    SlashCommand {
        name: "/task",
        takes_arg: true,
        summary: "wipe + re-key the worktree onto a PR or branch, then start a fresh task",
    },
    SlashCommand {
        name: "/exit",
        takes_arg: false,
        summary: "quit agentj",
    },
    SlashCommand {
        name: "/quit",
        takes_arg: false,
        summary: "quit agentj",
    },
];

/// How the command token of a line should be highlighted.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum TokenClass {
    /// Not a slash command — render plainly.
    Plain,
    /// Exactly a known command.
    Exact,
    /// A valid prefix of a known command.
    Prefix,
    /// Starts with `/` but matches nothing.
    Unknown,
}

/// Split a line into (command token, remainder) and classify the token for highlighting.
pub fn classify(line: &str, cmds: &[SlashCommand]) -> (String, String, TokenClass) {
    if !line.starts_with('/') {
        return (line.to_string(), String::new(), TokenClass::Plain);
    }
    let (token, rest) = match line.find(' ') {
        Some(i) => (&line[..i], &line[i..]),
        None => (line, ""),
    };
    let class = if cmds.iter().any(|c| c.name == token) {
        TokenClass::Exact
    } else if cmds.iter().any(|c| c.name.starts_with(token)) {
        TokenClass::Prefix
    } else {
        TokenClass::Unknown
    };
    (token.to_string(), rest.to_string(), class)
}

/// The result of a Tab completion: the (possibly extended) line, plus candidates when ambiguous.
pub struct Completion {
    pub line: String,
    pub candidates: Vec<SlashCommand>,
}

fn longest_common_prefix(names: &[&str]) -> String {
    let mut p = names.first().map(|s| s.to_string()).unwrap_or_default();
    for s in names {
        while !s.starts_with(&p) {
            p.pop();
        }
    }
    p
}

/// Compute a Tab completion. Only completes the command token (before any space). Unique match →
/// full command (+ trailing space if it takes an arg); ambiguous → extend to the common prefix, else
/// return the candidates to list. No match / not a command ⇒ line unchanged.
pub fn complete_command(line: &str, cmds: &[SlashCommand]) -> Completion {
    if !line.starts_with('/') || line.contains(' ') {
        return Completion {
            line: line.to_string(),
            candidates: vec![],
        };
    }
    let matches: Vec<SlashCommand> = cmds
        .iter()
        .copied()
        .filter(|c| c.name.starts_with(line))
        .collect();
    match matches.len() {
        0 => Completion {
            line: line.to_string(),
            candidates: vec![],
        },
        1 => {
            let c = matches[0];
            Completion {
                line: format!("{}{}", c.name, if c.takes_arg { " " } else { "" }),
                candidates: vec![],
            }
        }
        _ => {
            let names: Vec<&str> = matches.iter().map(|c| c.name).collect();
            let lcp = longest_common_prefix(&names);
            if lcp.len() > line.len() {
                Completion {
                    line: lcp,
                    candidates: vec![],
                }
            } else {
                Completion {
                    line: line.to_string(),
                    candidates: matches,
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_highlights() {
        assert_eq!(classify("fix the bug", SLASH_COMMANDS).2, TokenClass::Plain);
        assert_eq!(classify("/task", SLASH_COMMANDS).2, TokenClass::Exact);
        assert_eq!(classify("/ta", SLASH_COMMANDS).2, TokenClass::Prefix);
        assert_eq!(classify("/nope", SLASH_COMMANDS).2, TokenClass::Unknown);
        let (token, rest, _) = classify("/task 2720 fix", SLASH_COMMANDS);
        assert_eq!(token, "/task");
        assert_eq!(rest, " 2720 fix");
    }

    #[test]
    fn completion() {
        assert_eq!(complete_command("/ta", SLASH_COMMANDS).line, "/task ");
        assert_eq!(complete_command("/ex", SLASH_COMMANDS).line, "/exit");
        let all = complete_command("/", SLASH_COMMANDS);
        assert_eq!(all.line, "/");
        assert_eq!(all.candidates.len(), 3);
        assert_eq!(complete_command("/zzz", SLASH_COMMANDS).line, "/zzz");
        assert_eq!(
            complete_command("/task 27", SLASH_COMMANDS).line,
            "/task 27"
        );
        assert_eq!(complete_command("hello", SLASH_COMMANDS).line, "hello");
    }
}
