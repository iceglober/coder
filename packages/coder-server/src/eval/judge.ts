// LLM-as-judge for the eval harness (test-projects/run.ts). Grades an OPEN-ENDED, ambiguous-hard task
// where there's no reference solution or fixed test spec — it judges the DESIGN in the agent's diff +
// report against a rubric. Lives here (not in test-projects/) so `ai`/`zod`/the model provider resolve
// from coder-server's node_modules. Not imported by the runtime; eval-only.
import { generateObject } from "ai";
import { z } from "zod";
import { resolveModel } from "../agent/models.ts";

const JudgeVerdict = z.object({
  criteria: z.array(z.object({ name: z.string(), met: z.boolean(), note: z.string() })),
  pass: z.boolean(),
  summary: z.string(),
});
export type JudgeVerdict = z.infer<typeof JudgeVerdict>;

/** Grade `diff` (+ the agent's `report`) against `rubric` with an LLM acting as a strict senior/staff
 *  reviewer. Reuses the project's configured model via `resolveModel({tier:"deep"})`. */
export async function judgeSolution(rubric: string, taskPrompt: string, report: string, diff: string): Promise<JudgeVerdict> {
  // Pin to the runtime's known-working model; override with CODER_JUDGE_MODEL if needed.
  const { model } = resolveModel({ tier: "deep", modelId: process.env.CODER_JUDGE_MODEL ?? "gemini-3.1-pro-preview" });
  const { object } = await generateObject({
    model,
    schema: JudgeVerdict,
    system:
      "You are a strict senior/staff engineer grading an AI coding agent's solution to an OPEN-ENDED design task. There is NO reference solution — judge the DESIGN and completeness against the rubric. Be rigorous: a plausible-looking but shallow, incoherent, or incomplete design FAILS. Reward sound, cohesive, idiomatic design; penalize over-engineering and any unaddressed criterion.",
    prompt: `TASK GIVEN TO THE AGENT:\n${taskPrompt}\n\nRUBRIC — grade against each criterion:\n${rubric}\n\nAGENT'S REPORT (its own account):\n${report.slice(-6000)}\n\nAGENT'S DIFF (the actual solution):\n${diff.slice(0, 24000)}\n\nFor each rubric criterion decide met/not with a short note. Then give an overall pass — true ONLY if the design is sound and the critical criteria are met — and a one-paragraph summary.`,
  });
  return object;
}
