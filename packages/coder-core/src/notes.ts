// Notes — the agent's mutable scratchpad: working memory it rewrites as a task
// progresses. Deliberately separate from receipts (append-only history that is never
// edited). Persisted via the event-log; the current view is last-write-wins per key.
import { appendEvent, readEvents } from "./event-log.ts";

interface NoteWrite {
  key: string;
  /** null = delete the key. */
  value: string | null;
}

export class Notes {
  /** @param path JSONL file under the worktree (e.g. `.coder/notes.jsonl`). */
  constructor(private readonly path: string) {}

  async set(at: string, key: string, value: string): Promise<void> {
    await appendEvent<NoteWrite>(this.path, at, { key, value });
  }

  async delete(at: string, key: string): Promise<void> {
    await appendEvent<NoteWrite>(this.path, at, { key, value: null });
  }

  /** Reduce the append-only log to the current view (last write wins per key). */
  async view(): Promise<Map<string, string>> {
    const entries = await readEvents<NoteWrite>(this.path);
    const view = new Map<string, string>();
    for (const { data } of entries) {
      if (data.value === null) view.delete(data.key);
      else view.set(data.key, data.value);
    }
    return view;
  }
}
