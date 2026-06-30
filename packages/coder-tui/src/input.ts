// Input layer — a minimal line reader, no third-party deps (AGENTS.md: self-contained).
//
// On a TTY it owns stdin in raw mode: the terminal's auto-echo is off, so keystrokes typed
// while the agent is streaming a response can't garble the output (we only echo while
// actively reading a line). Off a TTY (pipes, tests) it falls back to plain line reading.
// The terminal is always restored — on close() and on process exit.
//
// Scope (4a): printable chars, Backspace, Enter, Ctrl-C / Ctrl-D. No arrow-key editing,
// no history yet.

/** Why a read returned null — lets the caller treat a Ctrl-C bail differently from EOF. */
export type EndReason = "ctrl-c" | "ctrl-d" | "eof";

export interface LineReader {
  /** Prompt and read one line. Resolves to the line, or null on Ctrl-C / Ctrl-D / EOF. */
  read(promptStr: string): Promise<string | null>;
  /** Why the most recent read resolved null. Undefined after a normal line. */
  readonly endReason?: EndReason;
  /** Restore the terminal and stop reading. */
  close(): void;
}

export function createLineReader(): LineReader {
  return process.stdin.isTTY ? rawReader() : cookedReader();
}

const ENTER = new Set(["\r", "\n"]);
const CTRL_C = 3;
const CTRL_D = 4;
const BACKSPACE = new Set([8, 127]);
const ESC = 27;

function rawReader(): LineReader {
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");

  let closed = false;
  let endReason: EndReason | undefined;
  const restore = () => {
    if (closed) return;
    closed = true;
    try {
      stdin.setRawMode(false);
    } catch {
      // terminal already gone
    }
    stdin.pause();
  };
  process.once("exit", restore);

  return {
    get endReason() {
      return endReason;
    },
    read(promptStr: string): Promise<string | null> {
      return new Promise((resolve) => {
        process.stdout.write(promptStr);
        endReason = undefined;
        let line = "";
        const onData = (data: string) => {
          for (const ch of data) {
            const code = ch.codePointAt(0) ?? 0;
            if (ENTER.has(ch)) {
              process.stdout.write("\n");
              stdin.off("data", onData);
              resolve(line);
              return;
            }
            if (code === CTRL_C || (code === CTRL_D && line === "")) {
              endReason = code === CTRL_C ? "ctrl-c" : "ctrl-d";
              process.stdout.write("\n");
              stdin.off("data", onData);
              resolve(null);
              return;
            }
            if (BACKSPACE.has(code)) {
              if (line.length > 0) {
                line = line.slice(0, -1);
                process.stdout.write("\b \b"); // erase the last glyph on screen
              }
              continue;
            }
            if (code === ESC) break; // drop escape sequences (arrows etc.) for now
            if (code < 32) continue; // ignore other control chars
            line += ch;
            process.stdout.write(ch); // echo (we control it, so streaming output stays clean)
          }
        };
        stdin.on("data", onData);
      });
    },
    close: restore,
  };
}

/** Plain line reader for non-TTY stdin (pipes, tests): buffer data, split on newlines. */
function cookedReader(): LineReader {
  const stdin = process.stdin;
  stdin.setEncoding("utf8");
  let buffer = "";
  let ended = false;
  const ready: string[] = [];
  let waiting: ((line: string | null) => void) | null = null;
  let endReason: EndReason | undefined;

  stdin.on("data", (d: string) => {
    buffer += d;
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (waiting) {
        const w = waiting;
        waiting = null;
        w(line);
      } else {
        ready.push(line);
      }
    }
  });
  stdin.on("end", () => {
    ended = true;
    if (waiting) {
      const w = waiting;
      waiting = null;
      w(null);
    }
  });

  return {
    get endReason() {
      return endReason;
    },
    read(promptStr: string): Promise<string | null> {
      process.stdout.write(promptStr);
      return new Promise((resolve) => {
        if (ready.length > 0) return resolve(ready.shift() ?? null);
        if (ended) {
          endReason = "eof";
          return resolve(null);
        }
        endReason = undefined;
        waiting = (line) => {
          if (line === null) endReason = "eof";
          resolve(line);
        };
      });
    },
    close() {
      stdin.pause();
    },
  };
}
