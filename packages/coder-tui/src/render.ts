// Event rendering — turns the agent's `ServerEvent` stream into terminal output. Kept
// separate from transport (client.ts) and the run loop. Three quiet gutters distinguish
// who's "speaking": `> ` the user (the input prompt), `· ` a tool call, `● ` the
// assistant's text (dimmed). No heavier styling yet.
import type { ServerEvent } from "coder-core";

/** Dim marker prefixing each assistant text run (reset to default fg after the glyph). */
const ASSISTANT_MARK = "\x1b[90m●\x1b[39m ";

/** Chars that begin a list/heading line — a marker before these reads as a double bullet,
 *  so we let those paragraphs render with their own leader instead. */
const LIST_LEAD = new Set(["-", "*", "+", "•", "#"]);
const startsListItem = (ch: string): boolean => LIST_LEAD.has(ch) || (ch >= "0" && ch <= "9");

function previewArgs(args: unknown): string {
  let s = "";
  try {
    s = JSON.stringify(args) ?? "";
  } catch {
    s = "";
  }
  return s.length > 80 ? `${s.slice(0, 80)}…` : s;
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
// Safety net: if we ever exit while the cursor is hidden (crash, kill), restore it so the user's
// terminal isn't left cursorless. Registered once; no-op when not a TTY (pipes/tests).
if (process.stdout.isTTY) process.once("exit", () => process.stdout.write(SHOW_CURSOR));
const dim = (s: string): string => `\x1b[90m${s}\x1b[39m`;
const fmtMs = (ms: number): string => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);

/** Keep the tool line within one terminal row so the `\r` redraw stays in place. */
function fitLabel(label: string): string {
  const cols = process.stdout.columns ?? 80;
  return label.length > cols - 14 ? `${label.slice(0, cols - 15)}…` : label;
}

/**
 * A stateful renderer for one turn. Tracks whether we're mid-assistant-text so the `● `
 * marker is written once at the start of each text run (and re-applied after a tool
 * interrupts it), without prefixing every streamed token.
 */
export function createTurnRenderer(): { event(e: ServerEvent): void; finish(): void } {
  const tty = !!process.stdout.isTTY;
  let started = false; // any content (above the status line) written yet?
  // A SINGLE bottom "heartbeat" line: shows in-flight tools or "thinking", plus a running clock —
  // so the turn never looks hung, whether tools are executing OR the model is reasoning between
  // steps. Completed tool lines + assistant text print ABOVE it. One managed line ⇒ robust under
  // concurrency (the model often runs several tools in one step).
  const inflight = new Map<string, { call: string; start: number }>(); // callId → running call
  let thinkingStart = Date.now(); // when the current thinking gap began (reset when tools finish)
  let frame = 0;
  let statusOn = false; // is the heartbeat line currently drawn?

  const clock = (ms: number): string => {
    const s = Math.floor(ms / 1000);
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60}s`;
  };
  const statusLine = (): string => {
    const running = [...inflight.values()];
    if (running.length) {
      // The running call WITH its args (the most-recently-started; commands are serial). `(+N)`
      // only when reads happen to overlap. Clock is that call's own elapsed.
      const cur = running[running.length - 1];
      const more = running.length > 1 ? ` (+${running.length - 1})` : "";
      return dim(`${SPINNER[frame]} ${cur.call}${more} · ${clock(Date.now() - cur.start)}`);
    }
    return dim(`${SPINNER[frame]} thinking · ${clock(Date.now() - thinkingStart)}`);
  };
  const drawStatus = (): void => {
    if (!tty) return;
    process.stdout.write(`\r\x1b[K${statusLine()}`);
    statusOn = true;
  };
  const clearStatus = (): void => {
    if (statusOn) {
      process.stdout.write("\r\x1b[K");
      statusOn = false;
    }
  };
  if (tty) process.stdout.write(HIDE_CURSOR); // hide it while the heartbeat owns the bottom line
  const timer = tty
    ? setInterval(() => {
        frame = (frame + 1) % SPINNER.length;
        drawStatus();
      }, 120)
    : undefined;
  timer?.unref?.(); // never hold the process open on the heartbeat

  const lead = (): void => {
    if (!started) {
      clearStatus();
      process.stdout.write("\n"); // one blank line between the prompt and the turn
      started = true;
    }
  };
  /** Print a finished line above the heartbeat (which redraws on the next tick). */
  const printAbove = (text: string): void => {
    clearStatus();
    process.stdout.write(`${text}\n`);
  };
  const writeAssistant = (text: string): void => {
    let buf = "";
    let nl = 2; // start of a run → the first line gets a marker too
    for (const ch of text) {
      if (ch === "\n") {
        buf += ch;
        nl++;
      } else {
        if (nl >= 2 && !startsListItem(ch)) buf += ASSISTANT_MARK; // skip the mark on list/heading lines
        buf += ch;
        nl = 0;
      }
    }
    printAbove(buf);
  };

  return {
    event(e: ServerEvent): void {
      switch (e.type) {
        case "message.delta": // one full chunk per step → terminate it so the heartbeat resumes below
          lead();
          writeAssistant(e.text);
          break;
        case "tool.start": {
          lead();
          inflight.set(e.callId, { call: fitLabel(`${e.tool}(${previewArgs(e.args)})`), start: Date.now() });
          drawStatus(); // TTY: reflect the now-running call immediately (no-op when piped)
          break;
        }
        case "tool.end": {
          const call = inflight.get(e.callId);
          inflight.delete(e.callId);
          if (inflight.size === 0) thinkingStart = Date.now(); // back to thinking — restart that clock
          const parts = [e.elapsedMs != null ? fmtMs(e.elapsedMs) : "", e.summary ?? e.status].filter(Boolean);
          printAbove(`· ${call?.call ?? "tool"} ${dim(`— ${parts.join(" ")}`)}`);
          break;
        }
        case "turn.error":
          lead();
          printAbove(`[error] ${e.message}`);
          break;
        // cost.update / turn.idle / permission.required: handled by the run loop.
      }
    },
    finish(): void {
      if (timer) clearInterval(timer);
      clearStatus();
      if (tty) process.stdout.write(SHOW_CURSOR); // restore it for the input prompt / next turn
    },
  };
}

/** Format the closing status line from the last cost update. Tolerates null/NaN fields
 *  (NaN serializes to null over JSON), so a malformed cost event never crashes the client. */
export function renderCost(
  costUsd: number | null,
  inputTokens: number | null,
  outputTokens: number | null,
  cachedTokens?: number | null,
): string {
  const cost = Number.isFinite(costUsd) ? `$${(costUsd as number).toFixed(4)}` : "$?";
  const inTok = inputTokens ?? 0;
  const outTok = outputTokens ?? 0;
  const cached = cachedTokens && inTok > 0 ? ` · ${Math.round((100 * cachedTokens) / inTok)}% cached` : "";
  return `— ${cost} · in ${inTok} / out ${outTok} tok${cached}\n`;
}
