// test_summary — a filter-surface operation bound to `bash` output. Turns a long test
// log into "N passed, M failed: here's which" before it ever reaches context (accuracy +
// token win), and extracts the pass/fail signal that becomes the receipt's accuracy
// signal. Non-test output passes straight through.
import type { FilterResult, Operation, OperationSignal } from "./index.ts";

export interface TestResult {
  passed: number;
  failed: number;
  /** Names of failing tests, best-effort (capped). */
  failing: string[];
}

/** Above this size, replace the raw log with the summary; below it, keep the detail. */
const COMPRESS_OVER = 1500;

/** Lines that signal a failure (the part the model actually needs to fix it). */
const FAILURE_ANCHOR =
  /(?:\bFAIL\b|✗|✖|×|●|⎯|AssertionError|\bError:|\bexpect\(|Expected|Received|^\s*at .+:\d+:\d+|\.(?:test|spec)\.[jt]sx?:\d+)/;

/**
 * From a long failing log, keep only the failure blocks — the assertion, the message, and the
 * `file:line` — and drop the passing noise. This is what lets the model fix the failure instead
 * of re-running the suite to hunt for it. Windows around each anchor are merged + char-capped.
 */
export function extractFailureDetail(raw: string, maxChars = 3000): string {
  const lines = raw.split("\n");
  const keep = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    if (!FAILURE_ANCHOR.test(lines[i])) continue;
    // Forward window only: the anchor line carries the header (FAIL … > name), and going backward
    // can pull in a huge passing-noise line that defeats the compression.
    for (let j = i; j <= Math.min(lines.length - 1, i + 10); j++) keep.add(j);
  }
  const out: string[] = [];
  let prev = -2;
  let chars = 0;
  for (const i of [...keep].sort((a, b) => a - b)) {
    if (i > prev + 1) out.push("  …");
    if (chars + lines[i].length > maxChars) {
      out.push("  … [failure detail truncated]");
      break;
    }
    out.push(lines[i]);
    chars += lines[i].length + 1;
    prev = i;
  }
  return out.join("\n").trim();
}

/** Extract pass/fail counts from bun / jest / pytest output. null = not a test log. */
export function parseTestOutput(raw: string): TestResult | null {
  let passed: number | null = null;
  let failed: number | null = null;

  const bunPass = raw.match(/^\s*(\d+)\s+pass\b/m);
  const bunFail = raw.match(/^\s*(\d+)\s+fail\b/m);
  const jest = raw.match(/Tests:\s+(?:(\d+)\s+failed,\s*)?(\d+)\s+passed/);

  if (bunPass || bunFail) {
    passed = bunPass ? Number(bunPass[1]) : 0;
    failed = bunFail ? Number(bunFail[1]) : 0;
  } else if (jest) {
    failed = jest[1] ? Number(jest[1]) : 0;
    passed = Number(jest[2]);
  } else if (/={3,}/.test(raw) && /\b\d+\s+(passed|failed)\b/.test(raw)) {
    // pytest summary line: "==== 3 passed, 1 failed in 0.1s ===="
    passed = Number(raw.match(/(\d+)\s+passed/)?.[1] ?? 0);
    failed = Number(raw.match(/(\d+)\s+failed/)?.[1] ?? 0);
  }

  if (passed === null && failed === null) return null;

  const failing: string[] = [];
  for (const m of raw.matchAll(/^\s*(?:✗|✖|×|\(fail\)|FAIL(?:ED)?)\s+(.+?)\s*$/gm)) {
    failing.push(m[1].trim());
    if (failing.length >= 25) break;
  }
  return { passed: passed ?? 0, failed: failed ?? 0, failing };
}

export const testFilter: Operation = {
  spec: {
    name: "test_summary",
    description: "Compress test-runner output to a pass/fail summary before it enters context.",
    locality: "local",
    effect: "read",
    trust: "builtin",
    surfaces: [{ kind: "filter", boundTo: "bash" }],
  },
  filter(output: string): FilterResult {
    const t = parseTestOutput(output);
    if (!t) return { text: output, applied: false };

    const signal: OperationSignal = {
      kind: "tests",
      passed: t.failed === 0,
      failed: t.failed,
      total: t.passed + t.failed,
    };

    // Keep the raw detail for short logs (the failing assertion matters); compress long ones.
    if (output.length <= COMPRESS_OVER) return { text: output, applied: true, signal };

    const lines = [`Tests: ${t.passed} passed, ${t.failed} failed.`];
    if (t.failed > 0) {
      // Keep the FAILURE detail (assertion + file:line) — not just counts. This is the fix:
      // the model reads the actual error here instead of re-running the suite to find it.
      const detail = extractFailureDetail(output);
      if (detail) lines.push("", detail);
      else if (t.failing.length) lines.push("Failing:", ...t.failing.map((n) => `  - ${n}`));
    } else {
      lines.push("(all passed — full output elided)");
    }
    return { text: lines.join("\n"), applied: true, signal };
  },
};
