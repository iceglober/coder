import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerEvent } from "coder-core";
import { MockLanguageModelV3 } from "ai/test";
import { Ledger } from "../src/ledger/index.ts";
import { runOnce } from "../src/runner.ts";

// We run the loop non-streaming (ToolLoopAgent.generate → doGenerate), so mocks return a
// provider-level generate result: content parts + nested usage + an object finishReason.
const usage = (inT: number, outT: number) => ({
  inputTokens: { total: inT, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: outT, text: undefined, reasoning: undefined },
});
// biome-ignore lint/suspicious/noExplicitAny: mock result shaped per the provider spec; bypass the strict union.
const gen = (content: any[], reason: string, inT: number, outT: number): any => ({
  finishReason: { unified: reason, raw: undefined },
  usage: usage(inT, outT),
  content,
  warnings: [],
});

/** A mock model that says something, calls write_file, then wraps up. */
function writeFileThenStop(): MockLanguageModelV3 {
  let call = 0;
  return new MockLanguageModelV3({
    doGenerate: async () => {
      call += 1;
      if (call === 1) {
        return gen(
          [
            { type: "text", text: "Creating the file." },
            { type: "tool-call", toolCallId: "c1", toolName: "write_file", input: JSON.stringify({ path: "out.txt", content: "generated" }) },
          ],
          "tool-calls",
          10,
          5,
        );
      }
      return gen([{ type: "text", text: "Done." }], "stop", 20, 8);
    },
  });
}

// N5: the loop is testable against a mock model — no network, no API key.
describe("runOnce against a mock model", () => {
  test("executes a tool call, then finishes, and writes a receipt", async () => {
    const model = writeFileThenStop();
    const root = await mkdtemp(join(tmpdir(), "coder-runner-"));
    try {
      const res = await runOnce({ task: "create out.txt with 'generated'", root, tier: "mid", model });

      expect(res.ok).toBe(true);
      expect(res.finishReason).toBe("stop");
      expect(res.changedFiles).toEqual(["out.txt"]); // deterministic accountability — what changed

      // The tool actually ran end-to-end.
      expect(await readFile(join(root, "out.txt"), "utf8")).toBe("generated");

      // Exactly one receipt, with usage + a computed cost.
      const receipts = await new Ledger(join(root, ".coder", "ledger.jsonl")).all();
      expect(receipts).toHaveLength(1);
      expect(receipts[0].outputTokens).toBeGreaterThan(0);
      expect(receipts[0].inputTokens).toBeGreaterThan(0);
      expect(receipts[0].costUsd).toBeGreaterThan(0);
      expect(receipts[0].verdict).toBe("unknown"); // correctness is borrowed, not computed
      expect(receipts[0].effort.toolCalls).toBe(1); // one write_file call
      expect(receipts[0].effort.filesWritten).toBe(1); // out.txt
      expect(receipts[0].effort.turns).toBeGreaterThanOrEqual(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("ask_user poses structured questions, ends the turn, and is not a sign-off resolution", async () => {
    let call = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        call += 1;
        if (call === 1) {
          return gen(
            [
              {
                type: "tool-call",
                toolCallId: "a1",
                toolName: "ask_user",
                input: JSON.stringify({
                  questions: [
                    { question: "Display or apply the palette?", options: [{ label: "Display as content" }, { label: "Apply as styling", default: true }] },
                  ],
                }),
              },
            ],
            "tool-calls",
            6,
            3,
          );
        }
        return gen([{ type: "text", text: "Asked the user to clarify." }], "stop", 6, 2);
      },
    });
    const root = await mkdtemp(join(tmpdir(), "coder-runner-"));
    const events: ServerEvent[] = [];
    try {
      const res = await runOnce({ task: "add a color palette", root, model, emit: (e) => events.push(e) });
      expect(res.ok).toBe(true);
      expect(res.askedUser).toBe(true);
      expect(res.signoffWorthy).toBe(false); // a question is never a resolution to sign off
      const q = events.find((e) => e.type === "questions.required");
      expect(q).toBeDefined();
      expect((q as { questions: { options: unknown[] }[] }).questions[0].options).toHaveLength(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("ask_user options carry a rich preview (swatches) through to the event", async () => {
    let call = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        call += 1;
        if (call === 1) {
          return gen(
            [
              {
                type: "tool-call",
                toolCallId: "a1",
                toolName: "ask_user",
                input: JSON.stringify({
                  questions: [
                    {
                      question: "Pick a palette",
                      options: [
                        { label: "Ocean", preview: { kind: "swatches", colors: ["#1f6f8b", "#2e8bc0"] } },
                        { label: "Earth", default: true, preview: { kind: "swatches", colors: ["#8b5e3c", "#c0922e"] } },
                      ],
                    },
                  ],
                }),
              },
            ],
            "tool-calls",
            6,
            3,
          );
        }
        return gen([{ type: "text", text: "Asked." }], "stop", 6, 2);
      },
    });
    const root = await mkdtemp(join(tmpdir(), "coder-runner-"));
    const events: ServerEvent[] = [];
    try {
      await runOnce({ task: "add a palette", root, model, emit: (e) => events.push(e) });
      const q = events.find((e) => e.type === "questions.required") as { questions: { options: { preview?: { kind: string; colors: string[] } }[] }[] } | undefined;
      const preview = q?.questions[0].options[0].preview;
      expect(preview?.kind).toBe("swatches");
      expect(preview?.colors).toEqual(["#1f6f8b", "#2e8bc0"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a rejection pays off — the next turn is steered away from the rejected approach", async () => {
    const root = await mkdtemp(join(tmpdir(), "coder-runner-"));
    try {
      const simple = () => new MockLanguageModelV3({ doGenerate: async () => gen([{ type: "text", text: "Tried approach A." }], "stop", 5, 2) });

      // Turn 1, then the user REJECTS it.
      const res1 = await runOnce({ task: "fix the overflow", root, model: simple() });
      await new Ledger(join(root, ".coder", "ledger.jsonl")).recordVerdict(res1.receipt!.id, "rejected");

      // Turn 2: capture the prompt the model is called with — it must carry the rejection steer.
      let captured = "";
      const model2 = new MockLanguageModelV3({
        doGenerate: async (options: { prompt: unknown }) => {
          captured = JSON.stringify(options.prompt);
          return gen([{ type: "text", text: "Tried approach B." }], "stop", 5, 2);
        },
      });
      await runOnce({ task: "still overflowing", root, model: model2 });
      expect(captured).toContain("REJECTED"); // the steer reached the model
      expect(captured).toContain("do NOT repeat the same approach");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("declare_command persists a runnable command to facts.json and surfaces it", async () => {
    let call = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        call += 1;
        if (call === 1) {
          return gen(
            [{ type: "tool-call", toolCallId: "d1", toolName: "declare_command", input: JSON.stringify({ task: "test", command: "docker compose up -d testdb && pnpm test" }) }],
            "tool-calls",
            6,
            3,
          );
        }
        return gen([{ type: "text", text: "Declared the test command." }], "stop", 6, 2);
      },
    });
    const root = await mkdtemp(join(tmpdir(), "coder-runner-"));
    const events: ServerEvent[] = [];
    try {
      await runOnce({ task: "how do I run the tests", root, model, emit: (e) => events.push(e) });
      const onDisk = JSON.parse(await readFile(join(root, ".coder", "facts.json"), "utf8"));
      expect(onDisk.commands.test).toBe("docker compose up -d testdb && pnpm test");
      const declared = events.some((e) => e.type === "message.delta" && (e as { text: string }).text.includes("📋 declared command: test"));
      expect(declared).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("remember records a project pattern (visible), persists it, denied in plan", async () => {
    const rememberModel = () =>
      new MockLanguageModelV3({
        doGenerate: (() => {
          let call = 0;
          return async () => {
            call += 1;
            if (call === 1) {
              return gen(
                [{ type: "tool-call", toolCallId: "m1", toolName: "remember", input: JSON.stringify({ key: "color-palette", ref: "docs/index.ts#:root", category: "design" }) }],
                "tool-calls",
                6,
                3,
              );
            }
            return gen([{ type: "text", text: "Recorded the palette pattern." }], "stop", 6, 2);
          };
        })(),
      });

    // auto posture: the pattern persists + a 🧠 line is emitted.
    const root = await mkdtemp(join(tmpdir(), "coder-runner-"));
    const events: ServerEvent[] = [];
    try {
      await runOnce({ task: "remember the palette", root, model: rememberModel(), emit: (e) => events.push(e) });
      const onDisk = JSON.parse(await readFile(join(root, ".coder", "facts.json"), "utf8"));
      expect(onDisk.patterns?.[0]).toMatchObject({ key: "color-palette", ref: "docs/index.ts#:root" });
      const remembered = events.some((e) => e.type === "message.delta" && (e as { text: string }).text.includes("🧠 remembered: color-palette"));
      expect(remembered).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }

    // plan posture: remember is denied — nothing persists.
    const root2 = await mkdtemp(join(tmpdir(), "coder-runner-"));
    try {
      await runOnce({ task: "remember the palette", root: root2, model: rememberModel(), permissionMode: "plan" });
      const file = await readFile(join(root2, ".coder", "facts.json"), "utf8").catch(() => "");
      expect(file).not.toContain("color-palette"); // denied → no pattern written
    } finally {
      await rm(root2, { recursive: true, force: true });
    }
  });

  test("counts repeated tool calls as a thrash signal in effort", async () => {
    let call = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        call += 1;
        // Two IDENTICAL greps (same args), then stop — the second bought no new info.
        if (call <= 2) {
          return gen(
            [{ type: "tool-call", toolCallId: `g${call}`, toolName: "grep", input: JSON.stringify({ pattern: "needle" }) }],
            "tool-calls",
            5,
            2,
          );
        }
        return gen([{ type: "text", text: "done" }], "stop", 5, 2);
      },
    });
    const root = await mkdtemp(join(tmpdir(), "coder-runner-"));
    try {
      const res = await runOnce({ task: "search twice", root, model });
      expect(res.receipt!.effort.toolCalls).toBe(2);
      expect(res.receipt!.effort.repeatedCalls).toBe(1); // the 2nd identical grep
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("emits the protocol event stream when given an emit callback", async () => {
    const model = writeFileThenStop();
    const events: ServerEvent[] = [];
    const root = await mkdtemp(join(tmpdir(), "coder-runner-"));
    try {
      const res = await runOnce({
        task: "create out.txt",
        root,
        tier: "mid",
        model,
        sessionId: "s1",
        emit: (e) => events.push(e),
      });
      expect(res.ok).toBe(true);

      const types = events.map((e) => e.type);
      expect(types).toContain("message.delta");
      // The deterministic "changed files" footer is emitted so the user can't miss what was modified.
      const deltas = events.filter((e) => e.type === "message.delta").map((e) => (e as { text: string }).text);
      expect(deltas.some((t) => t.includes("changed 1 file: out.txt"))).toBe(true);
      expect(types).toContain("tool.start");
      expect(types).toContain("tool.end"); // executed write_file result, via onStepFinish
      expect(types).toContain("cost.update");
      expect(types.at(-1)).toBe("turn.idle"); // terminal event last
      expect(types).not.toContain("turn.error");

      // Every event carries the session id; the tool call + result are surfaced by id.
      expect(events.every((e) => e.sessionId === "s1")).toBe(true);
      const toolStart = events.find((e) => e.type === "tool.start") as Extract<ServerEvent, { type: "tool.start" }>;
      expect(toolStart).toMatchObject({ tool: "write_file" });
      const toolEnd = events.find((e) => e.type === "tool.end") as Extract<ServerEvent, { type: "tool.end" }>;
      expect(toolEnd.callId).toBe(toolStart.callId); // start/end correlate by the wrapper's id
      expect(toolEnd.status).toBe("ok");
      expect(typeof toolEnd.elapsedMs).toBe("number"); // timing for the elapsed display
      expect(toolEnd.summary).toBeTruthy(); // terse status

      // cost.update streams incrementally: input tokens are non-decreasing.
      const costs = events.filter((e) => e.type === "cost.update") as Extract<ServerEvent, { type: "cost.update" }>[];
      expect(costs.length).toBeGreaterThanOrEqual(1);
      for (let i = 1; i < costs.length; i++) expect(costs[i].inputTokens).toBeGreaterThanOrEqual(costs[i - 1].inputTokens);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a step-limit cut-off flags cutOff and still concludes with a receipt", async () => {
    let n = 0;
    // Always asks for a tool call → never stops on its own → hits MAX_STEPS → forced progress note.
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        n += 1;
        return gen(
          [{ type: "tool-call", toolCallId: `r${n}`, toolName: "read_file", input: JSON.stringify({ path: "missing.txt" }) }],
          "tool-calls",
          3,
          1,
        );
      },
    });
    const root = await mkdtemp(join(tmpdir(), "coder-runner-"));
    try {
      const res = await runOnce({ task: "loops forever", root, model });
      expect(res.ok).toBe(true);
      expect(res.cutOff).toBe(true); // hit the ceiling
      expect(res.receipt!.finishReason).toBe("stop"); // forced conclusion → always an answer
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("tolerates NaN token counts from the provider — cost never becomes NaN", async () => {
    const model = new MockLanguageModelV3({
      doGenerate: async () => gen([{ type: "text", text: "hi" }], "stop", 10, Number.NaN),
    });
    const root = await mkdtemp(join(tmpdir(), "coder-runner-"));
    try {
      const res = await runOnce({ task: "x", root, model });
      expect(res.ok).toBe(true);
      expect(Number.isFinite(res.receipt!.costUsd)).toBe(true);
      expect(Number.isFinite(res.receipt!.totalTokens ?? Number.NaN)).toBe(true);
      expect(res.receipt!.outputTokens).toBe(0); // recovered, not NaN
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("threads conversation history across turns", async () => {
    const seen: string[] = [];
    const reply = new MockLanguageModelV3({
      doGenerate: async (options) => {
        seen.push(JSON.stringify(options.prompt)); // what the model actually received
        return gen([{ type: "text", text: "ok" }], "stop", 5, 2);
      },
    });

    const root = await mkdtemp(join(tmpdir(), "coder-runner-"));
    try {
      const r1 = await runOnce({ task: "remember the number 42", root, model: reply });
      expect(r1.messages?.length).toBeGreaterThanOrEqual(2); // user + assistant

      const r2 = await runOnce({ task: "what number?", root, model: reply, history: r1.messages });
      expect(r2.ok).toBe(true);

      // The second call must carry the first turn's content, not just the new question.
      expect(seen[1]).toContain("remember the number 42");
      expect(seen[1]).toContain("what number?");
      // First call had no prior history.
      expect(seen[0]).not.toContain("what number?");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
