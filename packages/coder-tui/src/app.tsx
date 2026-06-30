// Full-screen Ink TUI with TABS — concurrent sessions in one window. The transcript is a TREE:
// a subagent run (investigate / implement) is a GROUP node whose tool calls stream live, then
// COLLAPSE into one row showing its verdict when it finishes (bracketed by phase.start/end from
// the engine). Arrow keys navigate nodes; Enter expands/collapses a group. Each tab shows the live
// CPU/RSS of the command it's running. The engine is unchanged — this renders its ServerEvent stream.
import { join } from "node:path";
import type { ChoicePreview, ClarifyQuestion } from "coder-core";
import { Box, render, Text, useApp, useInput, useStdout } from "ink";
import { useEffect, useRef, useState } from "react";
import { fmtBytes, Ledger, type Posture, type Provider, runOnce, sampleByPgid } from "coder-server";

const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
type History = Awaited<ReturnType<typeof runOnce>>["messages"];

interface UserNode {
  kind: "user";
  text: string;
}
interface MsgNode {
  kind: "msg";
  text: string;
}
interface ToolNode {
  kind: "tool";
  text: string;
}
interface GroupNode {
  kind: "group";
  label: string;
  tools: string[];
  verdict: string;
  running: boolean;
  collapsed: boolean;
}
export type Node = UserNode | MsgNode | ToolNode | GroupNode;

interface Session {
  id: string;
  nodes: Node[];
  sel: number; // selected node index in nav mode, -1 = none (live tail)
  nav: boolean; // arrows navigate the transcript (Esc) vs browse input history (default)
  history: History;
  running: boolean;
  cost: number;
  ctxTokens: number;
  prime: number; // estimated tokens of the persistent (main-agent) context
  subagentTotal: number; // cumulative ephemeral subagent tokens this session
  input: string;
  inputHistory: string[];
  histIdx: number; // -1 = editing, else position in inputHistory
  questions?: ClarifyQuestion[]; // structured clarification awaiting answers
  answers: number[]; // chosen option index per question
  qIdx: number; // current question being answered
  qDeadline?: number; // ms timestamp to auto-select the default (a timed proposal); cleared on any keypress
  pending?: string;
  sandbox: "host" | "docker";
  live: LiveTool[]; // tools running right now — shown with a progress spinner the moment they start
  cpu: number;
  rss: number;
}

interface LiveTool {
  callId: string;
  label: string; // tool(args)
  start: number; // ms, for the elapsed clock
}

export interface InkChatOptions {
  root: string;
  modelId?: string;
  provider?: Provider;
  permissionMode?: Posture;
}

let seq = 0;
function newSession(sandbox: "host" | "docker"): Session {
  seq += 1;
  return {
    id: `s${seq}`,
    nodes: [], // empty — the keybind hint renders as a non-navigable placeholder
    sel: -1,
    nav: false,
    history: undefined,
    running: false,
    cost: 0,
    ctxTokens: 0,
    prime: 0,
    subagentTotal: 0,
    input: "",
    inputHistory: [],
    histIdx: -1,
    answers: [],
    qIdx: 0,
    sandbox,
    live: [],
    cpu: 0,
    rss: 0,
  };
}

const openGroup = (nodes: Node[]): number => {
  for (let i = nodes.length - 1; i >= 0; i--) if (nodes[i].kind === "group" && (nodes[i] as GroupNode).running) return i;
  return -1;
};

function App({ root, modelId, provider, permissionMode }: InkChatOptions): JSX.Element {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const rows = stdout.rows ?? 24;
  const cols = stdout.columns ?? 80;

  const [sessions, setSessions] = useState<Session[]>(() => [newSession("host")]);
  const [active, setActive] = useState(0);
  const [frame, setFrame] = useState(0);
  const [blink, setBlink] = useState(false);
  const [, bumpTick] = useState(0); // 1s re-render while a timed proposal counts down

  const fireTimeout = useRef<() => void>(() => {}); // reassigned each render with fresh closures
  const acs = useRef(new Map<string, AbortController>());
  const pgids = useRef(new Map<string, number>());
  const holds = useRef(new Map<string, number>()); // peak-hold ticks so a reading stays visible after a command ends

  const patch = (id: string, fn: (s: Session) => Session): void => setSessions((ss) => ss.map((s) => (s.id === id ? fn(s) : s)));
  const addText = (id: string, text: string): void =>
    patch(id, (s) => {
      const i = openGroup(s.nodes);
      const nodes = [...s.nodes];
      if (i >= 0) {
        const g = nodes[i] as GroupNode;
        nodes[i] = { ...g, verdict: g.verdict + text };
      } else {
        const last = nodes[nodes.length - 1];
        if (last?.kind === "msg") nodes[nodes.length - 1] = { kind: "msg", text: last.text + text };
        else nodes.push({ kind: "msg", text });
      }
      return { ...s, nodes };
    });

  const anyRunning = sessions.some((s) => s.running);
  useEffect(() => {
    if (!anyRunning) return;
    const t = setInterval(() => setFrame((f) => (f + 1) % SPIN.length), 100);
    return () => clearInterval(t);
  }, [anyRunning]);

  // Sample command resource use often (commands are frequently sub-second) and PEAK-HOLD the last
  // non-zero reading for a few ticks after the command ends — otherwise it snaps to 0 the instant
  // onCommand(null) fires and a short command's load is never visible.
  useEffect(() => {
    const HOLD = 5; // ticks (~1.25s at 250ms) to keep a reading on screen after a command ends
    const t = setInterval(async () => {
      const live = [...pgids.current.values()];
      const usage = live.length ? await sampleByPgid(live) : new Map<number, { cpu: number; rss: number }>();
      setSessions((ss) =>
        ss.map((s) => {
          const pg = pgids.current.get(s.id);
          const u = pg ? usage.get(pg) : undefined;
          const cpu = u?.cpu ?? 0;
          const rss = u?.rss ?? 0;
          if (cpu > 0 || rss > 0) {
            holds.current.set(s.id, HOLD); // fresh reading — show it and arm the hold
            return s.cpu === cpu && s.rss === rss ? s : { ...s, cpu, rss };
          }
          const h = holds.current.get(s.id) ?? 0;
          if (h > 0) {
            holds.current.set(s.id, h - 1); // no reading but still holding the last one
            return s;
          }
          return s.cpu === 0 && s.rss === 0 ? s : { ...s, cpu: 0, rss: 0 };
        }),
      );
    }, 250);
    return () => clearInterval(t);
  }, []);

  // Blink the alien scholar's eyes while its clarification modal is up: shut briefly every few secs.
  const modalUp = !!sessions[active]?.questions?.length;
  useEffect(() => {
    if (!modalUp) return;
    const t = setInterval(() => {
      setBlink(true);
      setTimeout(() => setBlink(false), 140);
    }, 3200);
    return () => clearInterval(t);
  }, [modalUp]);

  // Drive a timed proposal's countdown: re-render each second and fire the auto-default at the deadline.
  useEffect(() => {
    if (!modalUp) return;
    const t = setInterval(() => {
      bumpTick((x) => x + 1);
      fireTimeout.current();
    }, 1000);
    return () => clearInterval(t);
  }, [modalUp]);

  const runTurn = async (id: string, text: string): Promise<void> => {
    patch(id, (s) => ({ ...s, nodes: [...s.nodes, { kind: "user", text }], running: true, sel: -1, nav: false, inputHistory: [...s.inputHistory, text], histIdx: -1 }));
    const session = sessions.find((s) => s.id === id);
    const ac = new AbortController();
    acs.current.set(id, ac);
    const res = await runOnce({
      task: text,
      root,
      modelId,
      provider,
      permissionMode,
      sandbox: session?.sandbox ?? "host",
      history: session?.history,
      signal: ac.signal,
      onCommand: (pgid) => (pgid ? pgids.current.set(id, pgid) : pgids.current.delete(id)),
      emit: (e) => {
        if (e.type === "phase.start") patch(id, (s) => ({ ...s, nodes: [...s.nodes, { kind: "group", label: e.label, tools: [], verdict: "", running: true, collapsed: false }] }));
        else if (e.type === "phase.end")
          patch(id, (s) => {
            const i = openGroup(s.nodes);
            if (i < 0) return s;
            const nodes = [...s.nodes];
            const g = nodes[i] as GroupNode;
            nodes[i] = { ...g, running: false, collapsed: true, verdict: g.verdict || e.verdict || "" };
            return { ...s, nodes };
          });
        else if (e.type === "questions.required")
          patch(id, (s) => ({
            ...s,
            questions: e.questions,
            answers: e.questions.map((q) => Math.max(0, q.options.findIndex((o) => o.default))),
            qIdx: 0,
            qDeadline: e.questions[0]?.timeoutSec ? Date.now() + e.questions[0].timeoutSec * 1000 : undefined,
          }));
        else if (e.type === "tool.start")
          // Show it the MOMENT it starts (live spinner + elapsed), not when it finishes.
          patch(id, (s) => ({ ...s, live: [...s.live, { callId: e.callId, label: `${e.tool}(${preview(e.args)})`, start: Date.now() }] }));
        else if (e.type === "tool.end")
          // Move the running tool into the transcript as a finished row, atomically.
          patch(id, (s) => {
            const lt = s.live.find((t) => t.callId === e.callId);
            const finished = `${lt?.label ?? "tool"} — ${[e.elapsedMs != null ? fmtMs(e.elapsedMs) : "", e.summary ?? e.status].filter(Boolean).join(" ")}`;
            const nodes = [...s.nodes];
            const gi = openGroup(nodes);
            if (gi >= 0) {
              const g = nodes[gi] as GroupNode;
              nodes[gi] = { ...g, tools: [...g.tools, finished] };
            } else nodes.push({ kind: "tool", text: finished });
            return { ...s, nodes, live: s.live.filter((t) => t.callId !== e.callId) };
          });
        else if (e.type === "message.delta") addText(id, e.text);
        else if (e.type === "cost.update") patch(id, (s) => ({ ...s, cost: e.costUsd, ctxTokens: e.inputTokens }));
      },
    }).catch((err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message : String(err) }));

    acs.current.delete(id);
    pgids.current.delete(id);
    patch(id, (s) => ({
      ...s,
      running: false,
      live: [], // clear any still-"running" tools the turn ended/aborted without an end event
      history: res.ok && res.messages ? res.messages : s.history,
      // Only ask for sign-off on a real resolution (a change / substantive answer) — not a greeting
      // or a clarifying question.
      pending: res.ok && res.signoffWorthy ? res.receipt?.id : undefined,
      // Context meter: prime = persistent main context now; subagentTotal accrues the ephemeral cost.
      prime: res.ok && res.usage ? res.usage.prime : s.prime,
      subagentTotal: s.subagentTotal + (res.ok && res.usage ? res.usage.subagent : 0),
    }));
    if (!res.ok && res.error && res.error !== "aborted") addText(id, `\n[error] ${res.error}`);
  };

  const submit = async (id: string, raw: string): Promise<void> => {
    const text = raw.trim();
    if (!text) return;
    if (text === "/exit") return exit();
    if (text === "/sandbox") return patch(id, (s) => ({ ...s, sandbox: s.sandbox === "host" ? "docker" : "host" }));
    await runTurn(id, text);
  };

  // Record the pick for the current question; advance to the next, or submit all choices as the turn.
  const answerQuestion = (cur: Session, opt: number): void => {
    if (!cur.questions) return;
    const answers = [...cur.answers];
    answers[cur.qIdx] = opt;
    if (cur.qIdx + 1 < cur.questions.length) {
      const next = cur.questions[cur.qIdx + 1];
      patch(cur.id, (s) => ({ ...s, answers, qIdx: s.qIdx + 1, qDeadline: next.timeoutSec ? Date.now() + next.timeoutSec * 1000 : undefined }));
      return;
    }
    const summary = cur.questions.map((q, i) => `• ${q.question} → ${q.options[answers[i]].label}`).join("\n");
    patch(cur.id, (s) => ({ ...s, questions: undefined, answers: [], qIdx: 0, qDeadline: undefined }));
    void submit(cur.id, `Here are my answers — proceed:\n${summary}`);
  };

  // Fire the auto-default when a timed proposal's deadline passes (driven by the 1s ticker above).
  fireTimeout.current = () => {
    const c = sessions[active];
    if (c?.questions?.length && c.qDeadline && Date.now() >= c.qDeadline) answerQuestion(c, c.answers[c.qIdx]);
  };

  useInput((char, key) => {
    const cur = sessions[active];
    if (!cur) return;
    if (key.ctrl && char === "t") return setSessions((ss) => [...ss, newSession(cur.sandbox)]), setActive(sessions.length);
    if (key.ctrl && char === "w") {
      if (sessions.length === 1) return exit();
      acs.current.get(cur.id)?.abort();
      setSessions((ss) => ss.filter((s) => s.id !== cur.id));
      return setActive((a) => Math.max(0, a - 1));
    }
    if (key.ctrl && char === "n") return setActive((a) => (a + 1) % sessions.length);
    if (key.ctrl && char === "p") return setActive((a) => (a - 1 + sessions.length) % sessions.length);
    if (key.ctrl && char === "c") {
      if (cur.running) acs.current.get(cur.id)?.abort();
      else exit();
      return;
    }
    // Structured clarification takes over input: ↑/↓ pick, a–d / Enter select + advance, Esc cancels.
    if (cur.questions?.length) {
      const q = cur.questions[cur.qIdx];
      if (cur.qDeadline) patch(cur.id, (s) => ({ ...s, qDeadline: undefined })); // engaged → stop the auto-default countdown
      if (key.escape) return patch(cur.id, (s) => ({ ...s, questions: undefined, answers: [], qIdx: 0, qDeadline: undefined }));
      if (key.upArrow) return patch(cur.id, (s) => ({ ...s, answers: s.answers.map((a, i) => (i === s.qIdx ? Math.max(0, a - 1) : a)) }));
      if (key.downArrow) return patch(cur.id, (s) => ({ ...s, answers: s.answers.map((a, i) => (i === s.qIdx ? Math.min(q.options.length - 1, a + 1) : a)) }));
      const pick = "abcd".indexOf(char) >= 0 ? "abcd".indexOf(char) : "1234".indexOf(char);
      if (pick >= 0 && pick < q.options.length) return answerQuestion(cur, pick);
      if (key.return) return answerQuestion(cur, cur.answers[cur.qIdx]);
      return; // swallow everything else while answering
    }
    // Esc is the trigger: flip arrows between input-history (default) and transcript navigation.
    if (key.escape) return patch(cur.id, (s) => ({ ...s, nav: !s.nav, sel: -1 }));
    if (key.upArrow)
      return cur.nav
        ? patch(cur.id, (s) => ({ ...s, sel: s.sel < 0 ? s.nodes.length - 1 : Math.max(0, s.sel - 1) }))
        : patch(cur.id, (s) => historyMove(s, -1));
    if (key.downArrow)
      return cur.nav
        ? patch(cur.id, (s) => ({ ...s, sel: s.sel < 0 || s.sel >= s.nodes.length - 1 ? -1 : s.sel + 1 }))
        : patch(cur.id, (s) => historyMove(s, +1));
    // Sign-off: bare y/n when a result awaits a verdict and the input is empty.
    if (cur.pending && !cur.running && !cur.input && !cur.nav && (char === "y" || char === "n")) {
      const accepted = char === "y";
      void new Ledger(join(root, ".coder", "ledger.jsonl")).recordVerdict(cur.pending, accepted ? "accepted" : "rejected");
      return patch(cur.id, (s) => ({ ...s, pending: undefined, nodes: [...s.nodes, { kind: "msg", text: `signed off: ${accepted ? "accepted ✓" : "rejected ✗"}` }] }));
    }
    if (key.return) {
      if (cur.input.trim()) {
        const t = cur.input;
        patch(cur.id, (s) => ({ ...s, input: "", histIdx: -1 }));
        void submit(cur.id, t);
      } else if (cur.nav && cur.sel >= 0 && cur.nodes[cur.sel]?.kind === "group") {
        patch(cur.id, (s) => {
          const nodes = [...s.nodes];
          const g = nodes[s.sel] as GroupNode;
          nodes[s.sel] = { ...g, collapsed: !g.collapsed };
          return { ...s, nodes };
        });
      }
      return;
    }
    if (cur.running) return; // input locked mid-turn
    if (key.backspace || key.delete) return patch(cur.id, (s) => ({ ...s, input: s.input.slice(0, -1), histIdx: -1 }));
    if (char && !key.ctrl && !key.meta) {
      // Typing edits the input and drops out of nav mode + any pending sign-off.
      patch(cur.id, (s) => ({ ...s, input: s.input + char, nav: false, histIdx: -1, pending: s.pending ? undefined : s.pending }));
    }
  });

  const cur = sessions[active] ?? sessions[0];
  // A pending clarification takes over the screen as a modal (the alien scholar's question).
  if (cur.questions?.length) {
    const remaining = cur.qDeadline ? Math.max(0, Math.ceil((cur.qDeadline - Date.now()) / 1000)) : null;
    return <QuestionModal rows={rows} cols={cols} blink={blink} question={cur.questions[cur.qIdx]} selected={cur.answers[cur.qIdx]} step={cur.qIdx + 1} total={cur.questions.length} remaining={remaining} />;
  }
  // Reserve 2 cols for the gutter bar + its space; content wraps within the rest.
  const CW = Math.max(1, cols - 2);
  // Render at most rows-1 lines total (1 tab + H transcript + 1 status + 1 input = rows-1). Filling
  // the FULL height makes the terminal scroll on the last newline, which corrupts Ink's redraw math
  // (stale lines overlap). The blank bottom line is the headroom that prevents that scroll.
  const H = Math.max(1, rows - 4);
  const visibleRows = flatten(cur.nodes, cur.live, CW, frame, Date.now());
  // Keep the selected node in view; otherwise pin to the bottom.
  let top = Math.max(0, visibleRows.length - H);
  if (cur.sel >= 0) {
    const selRow = visibleRows.findIndex((r) => r.node === cur.sel);
    if (selRow >= 0) top = Math.min(Math.max(0, selRow - 1), Math.max(0, visibleRows.length - H));
  }
  const shown = visibleRows.slice(top, top + H);
  const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);
  // Context meter: prime = persistent main-agent context (the budget that compounds); sub = the
  // ephemeral subagent tokens spent this session (the cost of isolation, which never persists).
  const ctx = ` · ctx prime ${k(cur.prime)}${cur.subagentTotal > 0 ? ` · sub ${k(cur.subagentTotal)}` : ""}`;
  const usage = cur.cpu > 0 || cur.rss > 0 ? ` · ${cur.cpu.toFixed(0)}% cpu ${fmtBytes(cur.rss)}` : "";

  return (
    <Box flexDirection="column" height={rows - 1} width={cols}>
      <Box>
        {sessions.map((s, i) => (
          <Text key={s.id} inverse={i === active} color={s.running ? "green" : undefined}>
            {` ${s.running ? `${SPIN[frame]} ` : ""}${i + 1} `}
          </Text>
        ))}
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        {shown.length === 0 ? (
          <Text color="gray">Enter to send · Esc → navigate (↑/↓ scroll, Enter expand) · ↑/↓ history · Ctrl-T tab · Ctrl-N/P switch · /sandbox · /exit</Text>
        ) : (
          shown.map((r, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: sliced, append-only rows
            <RowText key={i} row={r} selected={cur.nav && r.node === cur.sel} />
          ))
        )}
      </Box>
      <Box>
        <Text color="gray">
          {cur.running ? `${SPIN[frame]} ` : ""}
          {modelId ?? "model"} · {cur.sandbox} · ${cur.cost.toFixed(4)}
          {ctx}
          {usage}
          {cur.nav ? " · [NAV] ↑/↓ move · Enter expand · Esc exit" : ""}
        </Text>
      </Box>
      <Box>
        <Text color={cur.pending && !cur.running ? "yellow" : undefined}>
          {cur.pending && !cur.running ? "✓ accept? (y/n) › " : "› "}
          {cur.input}
        </Text>
        <Text color="gray">{cur.running ? "" : "▏"}</Text>
      </Box>
    </Box>
  );
}

// The alien scholar — hero art for the clarification modal (jgs). One block so per-line centering
// doesn't distort it; `eyes` is swapped to blink (same width open/shut, so nothing shifts).
const alienArt = (eyes: string): string =>
  [
    "              (",
    "           __..)__",
    "         .'       `'.",
    "        / - -        `\\",
    `       /${eyes}         \\`,
    "       /  ^        )   |",
    " _     \\.--.           |",
    "/ \\_    \\--'          /",
    "\\   )    \\__.-' __..''",
    "`) '.   /     |",
    "  \\   './   \\   \\",
    "   '.  /     |   \\",
    "    '\\;      |   ,;",
    "     |       |   | |",
    "     |       |  /  |      __",
    "     |       \\ '-, |      \\ '.",
    "     |        '._) |      |   \\",
    "      \\            |      /_  |",
    "       '.          /_..--\"  \\/",
    "         `;.    .-'--..___.-'",
    "jgs       | |  /",
    " .-\"\"\"\"\"-.| | |__..--\"\"-.",
    "(         _.|            \\",
    " '-....-'`   `\"\"--...__.-'",
  ].join("\n");

/** A full-screen modal: an alien-scholar hero above one structured multiple-choice question. */
function QuestionModal({
  rows,
  cols,
  blink,
  question,
  selected,
  step,
  total,
  remaining,
}: {
  rows: number;
  cols: number;
  blink: boolean;
  question: ClarifyQuestion;
  selected: number;
  step: number;
  total: number;
  remaining: number | null;
}): JSX.Element {
  return (
    <Box height={rows - 1} width={cols} justifyContent="center" alignItems="center">
      <Box flexDirection="column" borderStyle="round" borderColor="green" paddingX={3} paddingY={1} width={Math.min(cols - 4, 66)}>
        <Box flexDirection="column" alignItems="center" marginBottom={1}>
          <Text color="green">{alienArt(blink ? "(-)(-)" : "(')(')")}</Text>
          <Text color="greenBright" bold>
            the alien scholar needs a decision
          </Text>
        </Box>
        <Text color="yellow" bold>
          ? {question.question}
          {total > 1 ? `  (${step}/${total})` : ""}
        </Text>
        <Box flexDirection="column" marginY={1}>
          {question.options.map((o, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed option list
            <Box key={i} flexDirection="column">
              <Text inverse={i === selected} color={i === selected ? "cyan" : undefined}>
                {` ${i === selected ? "❯" : " "} ${"abcd"[i]}  ${o.label}${o.default ? "  · recommended" : ""}${o.description ? ` — ${o.description}` : ""} `}
              </Text>
              {o.preview ? <ChoicePreviewView preview={o.preview} /> : null}
            </Box>
          ))}
        </Box>
        {remaining != null ? (
          <Text color="yellow">⏳ auto-selecting the recommended option in {remaining}s · press any key to decide yourself</Text>
        ) : null}
        <Text color="gray">↑/↓ move · a–d pick · Enter select · Esc cancel</Text>
      </Box>
    </Box>
  );
}

/** Renders a choice's rich preview under its label — colors as swatches, code/tree/text as a
 *  truncated block, a chart as scaled bars. Unknown kinds render nothing. */
function ChoicePreviewView({ preview }: { preview: ChoicePreview }): JSX.Element | null {
  const indent = "       "; // align under the option label (past "❯ a  ")
  if (preview.kind === "swatches") {
    const colors = preview.colors.slice(0, 8);
    return (
      <Box>
        <Text>{indent}</Text>
        {colors.map((c, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed swatch list
          <Text key={i} color={c}>
            {"██ "}
          </Text>
        ))}
        <Text color="gray">{colors.join(" ")}</Text>
      </Box>
    );
  }
  if (preview.kind === "chart") {
    const max = Math.max(1, ...preview.bars.map((b) => b.value));
    return (
      <Box flexDirection="column">
        {preview.bars.slice(0, 6).map((b, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed bar list
          <Text key={i} color="gray">
            {`${indent}${b.label.slice(0, 12).padEnd(12)} ${"█".repeat(Math.round((b.value / max) * 16))} ${b.value}`}
          </Text>
        ))}
      </Box>
    );
  }
  // code | tree | text — a truncated monospace block
  const lines = preview.text.split("\n").slice(0, 5);
  return (
    <Box flexDirection="column">
      {lines.map((l, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: sliced block
        <Text key={i} color="gray">
          {`${indent}${l}`}
        </Text>
      ))}
    </Box>
  );
}

// ── rendering ───────────────────────────────────────────────────────────────
type RowKind = "user" | "msg" | "tool" | "group-head" | "child" | "verdict" | "spacer";
type MdRole = "plain" | "h1" | "h2" | "h3" | "bullet" | "quote" | "code" | "rule";
type Gutter = "user" | "assistant" | "tool" | "group" | "none";
interface Row {
  node: number; // -1 for a spacer (never matches sel)
  kind: RowKind;
  text: string; // marker + indent already baked in; never contains \n; ≤ content width
  style?: MdRole;
  gutter: Gutter;
}

const GUTTER_COLOR: Record<Gutter, string | undefined> = { user: "cyan", assistant: "green", tool: "gray", group: "magenta", none: undefined };

/** Format markdown text into one-physical-line rows. Classify each LOGICAL line (split on \n)
 *  BEFORE wrapping so a wrapped continuation keeps its role and never gets a second marker. */
function emitMarkdown(node: number, raw: string, gutter: Gutter, width: number): Row[] {
  const out: Row[] = [];
  let inFence = false;
  for (const logical of raw.split("\n")) {
    if (/^\s*```/.test(logical)) {
      inFence = !inFence;
      out.push({ node, kind: "verdict", text: "╶───╴", style: "rule", gutter });
      continue;
    }
    if (inFence) {
      for (const w of wrapLine(logical, Math.max(1, width - 2))) out.push({ node, kind: "verdict", text: `  ${w}`, style: "code", gutter });
      continue;
    }
    let style: MdRole = "plain";
    let body = logical;
    let marker = "";
    let indent = "";
    const h = logical.match(/^(#{1,3}) +(.*)/);
    if (h) {
      style = (["h1", "h2", "h3"] as const)[h[1].length - 1];
      body = h[2];
    } else if (/^\s*[-*] +/.test(logical)) {
      style = "bullet";
      body = logical.replace(/^\s*[-*] +/, "");
      marker = "• ";
      indent = "  ";
    } else if (/^> ?/.test(logical)) {
      style = "quote";
      body = logical.replace(/^> ?/, "");
    }
    const lines = wrapLine(body, Math.max(1, width - marker.length));
    if (!lines.length) out.push({ node, kind: "verdict", text: "", style, gutter });
    lines.forEach((w, i) => out.push({ node, kind: "verdict", text: `${i === 0 ? marker : indent}${w}`, style, gutter }));
  }
  return out;
}

export function flatten(nodes: Node[], live: LiveTool[], width: number, frame: number, now: number): Row[] {
  const out: Row[] = [];
  nodes.forEach((n, i) => {
    if (n.kind === "user") {
      if (i > 0) out.push({ node: -1, kind: "spacer", text: "", gutter: "none" }); // breathing room between turns
      // wrap to width-2 so the "› "/"  " prefix never pushes a line past the content width
      wrapLine(n.text, Math.max(1, width - 2)).forEach((w, j) => out.push({ node: i, kind: "user", text: `${j === 0 ? "› " : "  "}${w}`, gutter: "user" }));
    } else if (n.kind === "msg") {
      out.push(...emitMarkdown(i, n.text, "assistant", width));
    } else if (n.kind === "tool") {
      out.push({ node: i, kind: "tool", text: `· ${clip(n.text, width - 2)}`, gutter: "tool" });
    } else {
      // A done group with no tools (e.g. a greeting / quick answer) is just an answer.
      if (!n.running && n.tools.length === 0) {
        out.push(...emitMarkdown(i, n.verdict, "assistant", width));
        return;
      }
      // Collapse hides the TOOL NOISE, never the conclusion: head + verdict always show when done.
      const note = `[${n.tools.length} tool${n.tools.length === 1 ? "" : "s"}]`;
      const head = n.running ? `${SPIN[frame]} ${n.label}… ${note}` : `${n.collapsed ? "▸" : "▾"} ${n.label} ${note}`;
      out.push({ node: i, kind: "group-head", text: head, gutter: "group" });
      if (n.running || !n.collapsed) for (const t of n.tools) out.push({ node: i, kind: "child", text: `· ${clip(t, width - 2)}`, gutter: "tool" });
      if (!n.running) out.push(...emitMarkdown(i, n.verdict, "assistant", width));
    }
  });
  // Tools running RIGHT NOW — shown the moment they start, with a spinner + live elapsed clock.
  for (const t of live) {
    const secs = Math.max(0, Math.round((now - t.start) / 1000));
    out.push({ node: -1, kind: "child", text: `${SPIN[frame]} ${clip(t.label, Math.max(1, width - 8))} · ${secs}s`, gutter: "tool" });
  }
  return out;
}

/** One transcript row = exactly one physical line: a colored gutter bar + styled content. */
function RowText({ row, selected }: { row: Row; selected: boolean }): JSX.Element {
  const gColor = GUTTER_COLOR[row.gutter];
  const gutter = (
    <>
      <Text color={gColor} dimColor={row.gutter === "tool"} inverse={selected} bold={selected}>
        {row.gutter === "none" ? " " : "▍"}
      </Text>
      <Text> </Text>
    </>
  );
  if (row.kind === "spacer") return <Text> </Text>;
  if (row.kind === "group-head") {
    return (
      <Text>
        {gutter}
        <Text bold color={row.text.startsWith("▸") || row.text.startsWith("▾") ? "magenta" : "green"}>
          {row.text}
        </Text>
      </Text>
    );
  }
  if (row.kind === "tool" || row.kind === "child") {
    return (
      <Text>
        {gutter}
        <Text color="gray" dimColor>
          {row.text || " "}
        </Text>
      </Text>
    );
  }
  if (row.kind === "user") {
    return (
      <Text>
        {gutter}
        <Text color="cyan">{row.text || " "}</Text>
      </Text>
    );
  }
  // msg / verdict — markdown-styled by role
  return (
    <Text>
      {gutter}
      <MdText text={row.text} style={row.style ?? "plain"} />
    </Text>
  );
}

/** Renders a markdown line's content by role; bullet/quote/plain also get inline bold + `code`. */
function MdText({ text, style }: { text: string; style: MdRole }): JSX.Element {
  if (style === "h1" || style === "h2" || style === "h3") {
    return (
      <Text bold color={style === "h1" ? "greenBright" : "green"}>
        {text || " "}
      </Text>
    );
  }
  if (style === "code" || style === "rule") {
    return (
      <Text color="gray" dimColor>
        {text || " "}
      </Text>
    );
  }
  // bullet / quote / plain → inline tokenizer (**bold** + `code`)
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return (
    <Text dimColor={style === "quote"}>
      {parts.map((p, i) =>
        p.startsWith("**") && p.endsWith("**") ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: stable split
          <Text key={i} bold>
            {p.slice(2, -2)}
          </Text>
        ) : p.startsWith("`") && p.endsWith("`") && p.length > 1 ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: stable split
          <Text key={i} color="yellow" dimColor>
            {p.slice(1, -1)}
          </Text>
        ) : (
          p
        ),
      )}
    </Text>
  );
}

function historyMove(s: Session, dir: -1 | 1): Session {
  if (!s.inputHistory.length) return s;
  let idx = s.histIdx === -1 ? s.inputHistory.length : s.histIdx;
  idx = Math.min(s.inputHistory.length, Math.max(0, idx + dir));
  const input = idx >= s.inputHistory.length ? "" : s.inputHistory[idx];
  return { ...s, histIdx: idx >= s.inputHistory.length ? -1 : idx, input };
}

// Split on EXISTING newlines first, then word-wrap each segment — so every returned row is exactly
// one physical terminal line. (Markdown messages are full of \n; if a row kept its \n it would
// render as several lines and break the H-rows = H-lines accounting → overflow + garbled redraw.)
function wrapLine(text: string, width: number): string[] {
  const rows: string[] = [];
  for (const segment of text.split("\n")) {
    if (segment.length <= width) {
      rows.push(segment);
      continue;
    }
    let line = "";
    for (const word of segment.split(" ")) {
      if (!line) line = word;
      else if (line.length + 1 + word.length <= width) line += ` ${word}`;
      else {
        rows.push(line);
        line = word;
      }
      while (line.length > width) {
        rows.push(line.slice(0, width));
        line = line.slice(width);
      }
    }
    rows.push(line);
  }
  return rows;
}
function clip(s: string, width: number): string {
  const flat = s.replace(/\s*\n\s*/g, " "); // a tool row is one line — never let an embedded \n break it
  return flat.length > width ? `${flat.slice(0, Math.max(1, width - 1))}…` : flat;
}
function preview(args: unknown): string {
  try {
    const s = JSON.stringify(args) ?? "";
    return s.length > 50 ? `${s.slice(0, 50)}…` : s;
  } catch {
    return "";
  }
}
function fmtMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export async function runInkChat(opts: InkChatOptions): Promise<void> {
  process.stdout.write("\x1b[?1049h\x1b[H");
  try {
    await render(<App {...opts} />).waitUntilExit();
  } finally {
    process.stdout.write("\x1b[?1049l");
  }
}
