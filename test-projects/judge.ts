// LLM judge for ambiguous-hard DESIGN tasks (no test spec pins the answer): grade agentj's diff +
// its own report against the task's rubric. Uses the same OpenAI-compatible endpoint agentj runs on
// (Azure Foundry / custom), auth'd exactly like the agent (Bearer). Returns null when no creds are
// configured, so the no-model `--selftest`/CI path skips the judge cleanly instead of erroring.
//
// Kept in its own module (not inside run.ts, which executes the whole harness on import) so it can be
// unit-tested for DISCRIMINATION — a judge that rubber-stamps everything is worse than no judge.
export interface JudgeVerdict {
  pass: boolean;
  reason: string;
}

export async function gradeJudge(rubric: string, diff: string, report: string): Promise<JudgeVerdict | null> {
  const base = process.env.AZURE_BASE_URL || process.env.AGENTJ_BASE_URL;
  const key = process.env.AZURE_API_KEY || process.env.AGENTJ_API_KEY;
  const model = process.env.AGENTJ_MODEL;
  if (!base || !key || !model) return null;
  const sys =
    "You are a strict staff-level engineering grader. You are given a grading RUBRIC, the candidate's " +
    "code DIFF, and the candidate's own REPORT. Decide whether the work PASSES the rubric. Be skeptical: " +
    "a thin wrapper, a hardcoded chain, over-engineering, or claims the diff does not support all FAIL. " +
    'Respond with ONLY a JSON object: {"pass": boolean, "reason": "<=40 words citing specifics"}.';
  const user = `RUBRIC:\n${rubric}\n\n=== DIFF (truncated) ===\n${diff.slice(0, 16000)}\n\n=== AGENT REPORT (tail) ===\n${report.slice(-4000)}`;
  const res = await fetch(`${base.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages: [{ role: "system", content: sys }, { role: "user", content: user }] }),
  });
  if (!res.ok) throw new Error(`judge HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const txt = data?.choices?.[0]?.message?.content ?? "";
  const m = txt.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`judge returned no JSON: ${txt.slice(0, 200)}`);
  const v = JSON.parse(m[0]) as { pass?: unknown; reason?: unknown };
  return { pass: !!v.pass, reason: String(v.reason ?? "").slice(0, 300) };
}
