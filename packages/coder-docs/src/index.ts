// coder-docs — a dependency-free concept guide for coder. `bun run packages/coder-docs/src/index.ts`
// (or `bun run dev`) serves it on CODER_DOCS_PORT (default 4180). Concepts live in SECTIONS; a live
// Build-status section is parsed from TODOS_1.md + TODOS_2.md on each request.
import { join } from "node:path";

interface Section {
  id: string;
  title: string;
  /** One-line definition shown under the heading. */
  lead: string;
  /** Trusted HTML body (authored here, not user input). */
  html: string;
}

// Each concept: a one-line definition (lead), then how/why in a few tight points.
const SECTIONS: Section[] = [
  {
    id: "thesis",
    title: "The bet",
    lead: "Long context makes models less accurate — not just pricier. So keep it short.",
    html: `<p>That one finding drives everything. coder spends tokens only where a model genuinely adds value, and
      <em>computes</em> the rest. It keeps what's in front of the model short and relevant — for accuracy first,
      cost second. Everything below is a consequence of that bet.</p>`,
  },
  {
    id: "capabilities",
    title: "Capabilities",
    lead: "One model: a few native tools, plus a dispatcher over a described catalog.",
    html: `<p>Everything coder can do is a <strong>capability</strong> — a named action, args → result, tagged with an
      <strong>effect</strong> (<code>read</code> / <code>verify</code> / <code>write</code>). What differs is only how
      it's <em>implemented</em> and how it's <em>provided</em> to the model — and that split is driven by tokens: a tool's
      definition sits in context on every request, so more tools mean more tokens <em>and</em> worse selection. So
      capabilities live on two surfaces:</p>
      <ul>
        <li><strong>Native tools</strong> — the hot path, always present with full schemas:
          <code>read_file</code>, <code>edit_file</code>, <code>grep</code>, <code>bash</code>, plus deterministic
          <em>operations</em> like <code>git_state</code> and <code>find_def</code> (plain code, no model call). A small
          set the model uses every turn.</li>
        <li><strong>A dispatcher + catalog</strong> — the long tail, provided cheaply. One <code>script(task, args)</code>
          tool, and a compact catalog the model picks from <em>by intent</em>:</li>
      </ul>
      <pre><code>script(name, {args}) — pick the one whose description fits:
- test · lint · build              (computed from the toolchain)
- pr-checks(pr) — list a PR's CI status     (declared → runs \`gh pr checks\`)
- test-db — stand up the test database      (declared)</code></pre>
      <p>A catalog line costs ~24 tokens; the same thing as a native tool is 60+, and a typical MCP tool 550–1,400.
      So a toolchain task, a project command, and an MCP tool (from a server in <code>.mcp.json</code>) are all just
      catalog entries the dispatcher routes to — different implementations, one cheap surface. If the model gets the args wrong, the dispatcher replies with the
      exact usage. A subagent's role is just a <em>filtered view of capabilities by effect</em> — that's the read-only
      investigator (read + verify, no write), no separate permission mode.</p>`,
  },
  {
    id: "filters",
    title: "Filters",
    lead: "Shrink a noisy capability's output before it reaches the model.",
    html: `<p>A <code>test_summary</code> filter turns a 500-line test log into "3 failed, here's which" <em>before</em> it
      enters context. Keeping intermediate results out of context is as valuable as keeping the catalog small — it's the
      other half of the token budget.</p>`,
  },
  {
    id: "subagents",
    title: "Subagents",
    lead: "coder decides per task: investigate first, or act directly.",
    html: `<p>A cheap <strong>triage</strong> routes the task. An investigation runs a read-only
      <strong>investigator</strong> in its own isolated context — it finds the root cause and returns a compact
      <strong>verdict</strong> (cause at <code>file:line</code>, evidence, the fix), never its 40-step transcript. An
      <strong>implementer</strong> then acts on that verdict.</p>
      <p>The orchestrator keeps only the verdict, and threads a compact <strong>working memory</strong> forward so "that
      PR" survives across turns. Direct actions are isolated the same way — only the compact result reaches history,
      never the tool transcript.</p>`,
  },
  {
    id: "context",
    title: "Context as a budget",
    lead: "Held for accuracy as much as cost. Fewest, most-relevant tokens win.",
    html: `<ul>
        <li><strong>Compaction</strong> — older turns summarize; recent ones stay verbatim.</li>
        <li><strong>Isolation</strong> — subagent exploration is discarded; only the verdict survives.</li>
        <li><strong>Data in tools, not prompts</strong> — project commands live in the <code>script</code> tool; the prompt is a pointer.</li>
      </ul>
      <p>The status line shows <strong>prime</strong> (your persistent context — small, compounding) vs <strong>sub</strong>
      (ephemeral subagent tokens — the cost of isolation, which never persists).</p>`,
  },
  {
    id: "knowledge",
    title: "Project knowledge",
    lead: "What coder knows about your repo — kept in .coder/, three distinct concerns.",
    html: `<ul>
        <li><strong>Config (computed)</strong> — detected <strong>toolchains</strong> (js, python; pluggable) from
          lockfiles + manifests, so <code>script("test", path)</code> runs the right command for the toolchain that
          governs that path. The npm-vs-pnpm class of error is gone; a monorepo path scopes to its package.</li>
        <li><strong>Runbook (declared)</strong> — the project-specific capabilities in the catalog, each
          <code>{ cmd, desc }</code>. coder picks them <em>by intent</em> from the description, so no command name ever
          lives in a prompt:
          <pre><code>"pr-checks": { "cmd": "gh pr checks {pr}", "desc": "list a PR's CI check status" }</code></pre>
          It builds these by <strong>onboarding like a new dev</strong> — when it can't tell how to run something it asks,
          then records the answer with <code>declare_command</code>.</li>
        <li><strong>Memory (learned)</strong> — durable patterns it should reuse (see below).</li>
      </ul>`,
  },
  {
    id: "patterns",
    title: "Pattern memory",
    lead: "Learn a project's patterns once; reuse them, never re-derive.",
    html: `<p>coder records durable <strong>patterns</strong> — design, architecture, tooling, conventions — with the
      <code>remember</code> tool. A pattern is a literal value or, better, a <strong>ref to live code</strong> — so it
      stays current when the code changes and reuse keeps the codebase DRY. Patterns persist in
      <code>.coder/facts.json</code> and inject as a compact <em>pointer index</em> each turn; the model reads a ref on
      demand, never carrying its contents in context.</p>`,
  },
  {
    id: "clarification",
    title: "Clarification",
    lead: "When a task is ambiguous, coder asks — structured, never prose.",
    html: `<p>Instead of guessing and sweeping, coder calls <code>ask_user</code> with 2–4 options and a recommended
      default, rendered as an interactive modal. Options can carry a rich <strong>preview</strong> — color swatches, a
      code snippet, a file tree, a chart. For a missing input it asks the delegation question — <em>have it · show me
      options · you decide</em> (default) — and a proposal can carry a timeout that auto-takes the default if you step
      away.</p>`,
  },
  {
    id: "verdicts",
    title: "Verdicts & sign-off",
    lead: "Correctness is borrowed from a human, never graded by the model.",
    html: `<p>No machine check tells you a task was done <em>right</em>. The only correctness signal is your one-key
      sign-off at the resolution event (<code>accepted</code> / <code>rejected</code> / <code>abandoned</code>). Tests and
      typecheck are <strong>gates, not scores</strong> — and only count when they actually exercise the goal.</p>
      <p>So coder's real job is to make that "yes" cheap: every conclusion is a <strong>verdict</strong> — lead with the
      answer, evidence at <code>file:line</code>, claims tagged <em>checked / reasoned / guess</em>, and a plain statement
      of what it did <em>not</em> check. A rejection <strong>pays off</strong>: it steers the next turn away from the
      rejected approach, and after two it forces a change of strategy.</p>`,
  },
  {
    id: "receipts",
    title: "Receipts",
    lead: "One append-only receipt per task — effort, cost, and the borrowed verdict.",
    html: `<p>Effort (turns, tool calls, files, time-in-tools) is <em>computed</em>; the verdict is <em>borrowed</em>.
      <code>/stats</code> rolls them up — verdict mix, accepted-rate, average effort. The north star is
      <strong>time-to-confirmed-resolution</strong>, trending down.</p>`,
  },
  {
    id: "permissions",
    title: "Permissions",
    lead: "A policy decides allow / ask / deny per tool call, keyed to its effect.",
    html: `<p>Postures: <code>auto</code> (default — edits and commands run), <code>ask</code> (prompt before writes /
      commands), <code>auto-edit</code> (auto edits, ask commands), <code>plan</code> (read-only). Reads are never gated.
      Posture is <em>your</em> stance on the acting agent — separate from a subagent's role, which is a toolset.</p>`,
  },
  {
    id: "models",
    title: "Models",
    lead: "Multi-provider, priced from models.dev, run non-streaming.",
    html: `<p>Gemini on Vertex (default) or Anthropic, through the Vercel AI SDK; <code>/model &lt;id&gt;</code> switches
      live. Pricing is pulled from the public <a href="https://models.dev">models.dev</a> catalog — cached and
      cache-aware. The loop runs <strong>non-streaming</strong>: Gemini-3's <em>thought signatures</em> carry reasoning
      between steps, and the streaming path mangles them on multi-step tool use.</p>`,
  },
  {
    id: "distillation",
    title: "Distillation",
    lead: "The self-improvement loop (roadmap).",
    html: `<p>The <strong>Distiller</strong> mines receipts for work coder keeps repeating and proposes a deterministic
      <strong>operation</strong> to replace it — turning inference paid for once into computation free forever. The same
      bet, applied by coder to its own history.</p>`,
  },
];

interface TodoItem {
  status: "done" | "partial" | "todo";
  text: string;
}
interface Area {
  title: string;
  items: TodoItem[];
}

const STATUS_OF: Record<string, TodoItem["status"]> = { "✅": "done", "🟡": "partial", "⬜": "todo" };
const BADGE: Record<TodoItem["status"], string> = { done: "✅", partial: "🟡", todo: "⬜" };

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** Light markdown for trusted TODOS text: escape, then `code` and **bold**. */
const lightMd = (s: string): string => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");

/** Parse TODOS_1.md (done) + TODOS_2.md (remaining) into per-area items — the granular build state. */
async function readStatus(): Promise<{ total: Record<TodoItem["status"], number>; areas: Area[] } | null> {
  try {
    let md = "";
    for (const f of ["TODOS_1.md", "TODOS_2.md"]) {
      try {
        md += `${await Bun.file(join(import.meta.dir, "../../../", f)).text()}\n`;
      } catch {
        // a file may be missing if run standalone — skip it
      }
    }
    if (!md.trim()) return null;
    let cur: Area = { title: "General", items: [] };
    const all = [cur];
    for (const line of md.split("\n")) {
      const h = line.match(/^#{2,3}\s+(.+)/);
      if (h) {
        cur = { title: h[1].replace(/[`*]/g, "").trim(), items: [] };
        all.push(cur);
        continue;
      }
      const m = line.match(/^\s*-\s*(✅|🟡|⬜)\s+(.+)/);
      if (m) cur.items.push({ status: STATUS_OF[m[1]], text: m[2].trim() });
    }
    const areas = all.filter((a) => a.items.length);
    const count = (s: TodoItem["status"]) => areas.reduce((n, a) => n + a.items.filter((i) => i.status === s).length, 0);
    return { total: { done: count("done"), partial: count("partial"), todo: count("todo") }, areas };
  } catch {
    return null;
  }
}

function renderStatus(status: Awaited<ReturnType<typeof readStatus>>): string {
  if (!status) return "";
  const { total, areas } = status;
  const body = areas
    .map((a) => {
      const items = a.items
        .map((i) => `<li class="t-${i.status}"><span class="badge">${BADGE[i.status]}</span> <span class="todo-text">${lightMd(i.text)}</span></li>`)
        .join("");
      return `<h3>${esc(a.title)}</h3><ul class="todos">${items}</ul>`;
    })
    .join("");
  return `<section id="status"><h2>Build status</h2>
    <p class="lead">What's actually shipped, live from <code>TODOS_1.md</code> + <code>TODOS_2.md</code>: <strong>✅ ${total.done} done</strong> · 🟡 ${total.partial} in progress · ⬜ ${total.todo} planned.</p>
    ${body}</section>`;
}

function renderPage(statusSection: string): string {
  const navItems = SECTIONS.map((s) => `<a href="#${s.id}">${s.title}</a>`);
  if (statusSection) navItems.push(`<a href="#status">Build status</a>`);
  const nav = navItems.join("");
  const sections = SECTIONS.map((s) => `<section id="${s.id}"><h2>${s.title}</h2><p class="lead">${s.lead}</p>${s.html}</section>`).join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>coder — concept guide</title>
<style>
  :root { color-scheme: light dark;
    --fg:#18181b; --muted:#6b7280; --accent:#BE3455; --bg:#fbfbfc; --code:#f1f1f3; --line:#e5e5ea; }
  @media (prefers-color-scheme: dark){ :root{ --fg:#e8e8ea; --muted:#9a9aa2; --accent:#FFBE98; --bg:#0b0b0c; --code:#18181b; --line:#26262b; } }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg);
    font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; -webkit-font-smoothing:antialiased; }
  .layout { display:flex; max-width:1040px; margin:0 auto; align-items:flex-start; padding:40px 24px; gap:56px; }
  .sidebar { position:sticky; top:40px; width:200px; flex-shrink:0; display:flex; flex-direction:column; gap:1px; max-height:calc(100vh - 80px); overflow-y:auto; }
  .sidebar .brand { font-size:1.4rem; font-weight:700; margin:0 0 .1rem; color:var(--accent); letter-spacing:-.02em; }
  .sidebar .tag { color:var(--muted); margin:0 0 1.4rem; font-size:.82rem; line-height:1.4; }
  .sidebar a { color:var(--muted); text-decoration:none; font-size:.875rem; padding:5px 9px; border-radius:6px; }
  .sidebar a:hover { background:var(--code); color:var(--fg); }
  .content { flex:1; min-width:0; max-width:680px; overflow-wrap:break-word; }
  .hero { margin:0 0 2.5rem; padding:0 0 2rem; border-bottom:1px solid var(--line); }
  .hero h1 { font-size:2.1rem; letter-spacing:-.03em; margin:0 0 .5rem; }
  .hero .pitch { font-size:1.12rem; color:var(--fg); margin:0 0 1.2rem; line-height:1.55; }
  .hero .pitch b { color:var(--accent); }
  .hero .sub { color:var(--muted); font-size:.92rem; margin:.6rem 0 0; }
  section { margin:0 0 2.4rem; scroll-margin-top:32px; }
  h2 { font-size:1.2rem; letter-spacing:-.01em; margin:0 0 .15rem; }
  .lead { color:var(--muted); font-size:.95rem; margin:0 0 .7rem; }
  p { margin:.6rem 0; } ul { margin:.6rem 0; padding-left:1.2rem; } li { margin:.3rem 0; }
  code { background:var(--code); padding:.1em .35em; border-radius:4px; font-size:.86em;
    font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
  pre { background:var(--code); padding:13px 15px; border-radius:8px; overflow:auto; margin:.8rem 0; font-size:.86em; }
  pre code { background:none; padding:0; font-size:1em; }
  a { color:var(--accent); }
  h3 { font-size:.95rem; margin:1.4rem 0 .3rem; color:var(--muted); text-transform:uppercase; letter-spacing:.04em; }
  ul.todos { list-style:none; padding-left:0; margin:.2rem 0 .8rem; display:flex; flex-direction:column; gap:7px; }
  ul.todos li { margin:0; display:flex; gap:9px; align-items:flex-start; font-size:.9rem; }
  .todo-text { flex:1; min-width:0; } .badge { flex-shrink:0; width:1.3rem; text-align:center; } .t-todo { color:var(--muted); }
  footer { margin-top:3rem; padding-top:1.4rem; border-top:1px solid var(--line); color:var(--muted); font-size:.82rem; }
  @media (max-width: 760px) {
    .layout { flex-direction:column; gap:20px; padding:24px 18px; }
    .sidebar { position:static; width:100%; max-height:none; overflow:visible; flex-direction:row; flex-wrap:wrap; align-items:center; gap:4px 8px; border-bottom:1px solid var(--line); padding-bottom:14px; }
    .sidebar .brand, .sidebar .tag { width:100%; }
    .sidebar .tag { margin-bottom:.4rem; }
  }
</style></head>
<body><div class="layout">
  <aside class="sidebar">
    <div class="brand">coder</div>
    <div class="tag">a coding agent that prefers computation to inference</div>
    ${nav}
  </aside>
  <main class="content">
    <div class="hero">
      <h1>coder</h1>
      <p class="pitch">A coding agent — same category as Claude Code or Opencode — that <b>prefers computing over thinking</b> and treats <b>context as a budget</b>, because long context makes models less accurate, not just pricier.</p>
      <pre><code>bun bin/coder                  # chat (default)
bun bin/coder --once "&lt;task&gt;" # one task, then exit</code></pre>
      <p class="sub">Set <code>GOOGLE_VERTEX_PROJECT</code> (Gemini on Vertex) or an Anthropic key. In chat: <code>/model</code> · <code>/facts</code> · <code>/stats</code>, <code>y</code>/<code>n</code> to sign off, <code>Esc</code> to scroll. Packages: <code>coder-core</code> · <code>coder-server</code> · <code>coder-tui</code> · <code>coder-docs</code>.</p>
    </div>
    ${sections}
    ${statusSection}
    <footer>Generated by <code>coder-docs</code> — concepts authored here; the Build status is read live from <code>TODOS_1.md</code> + <code>TODOS_2.md</code> on each request.</footer>
  </main>
</div></body></html>`;
}

const port = Number(process.env.CODER_DOCS_PORT) || 4180;

Bun.serve({
  port,
  async fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname === "/health") return Response.json({ ok: true });
    const page = renderPage(renderStatus(await readStatus()));
    return new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } });
  },
});

console.error(`coder-docs on http://localhost:${port}`);
