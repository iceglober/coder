// Append-only event log — the crash-safe substrate behind the Ledger, sessions, and
// structured note-taking (PLAN N4: state derivable by replay). One JSONL file per stream.

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface LogEntry<T = unknown> {
  /** Monotonic-ish timestamp (ISO). Passed in by the caller — core stays pure. */
  at: string;
  data: T;
}

/** Append a single entry to a JSONL log. Atomic per-line; safe to tail concurrently. */
export async function appendEvent<T>(path: string, at: string, data: T): Promise<void> {
  const entry: LogEntry<T> = { at, data };
  await mkdir(dirname(path), { recursive: true }); // self-sufficient: create .coder/ if absent
  await appendFile(path, JSON.stringify(entry) + "\n", "utf8");
}

/** Read & parse all entries from a JSONL log. Missing file → empty. */
export async function readEvents<T>(path: string): Promise<LogEntry<T>[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as LogEntry<T>);
}
