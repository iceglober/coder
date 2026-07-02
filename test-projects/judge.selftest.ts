#!/usr/bin/env bun
// Discrimination check for the LLM judge: it must PASS a genuinely extensible design and FAIL a thin
// hardcoded chain against the SAME rubric. A judge that rubber-stamps everything is worse than none.
// Needs model creds (AZURE_BASE_URL/AZURE_API_KEY/AGENTJ_MODEL); skips cleanly without them.
import { gradeJudge } from "./judge.ts";

const RUBRIC =
  "Grade as a staff engineer reviewing an extensible pricing pipeline. (1) ABSTRACTION: a clear rule " +
  "type/interface mapping a running total to a new total, not ad-hoc branching. (2) COMPOSITION: rules " +
  "apply in an explicit ORDER via a pipeline/reduce. (3) EXTENSIBILITY: adding a rule type means writing " +
  "a new rule, NOT editing a central switch; shown with >=2 concrete rules. (4) SAFETY: total floored at " +
  ">=0. PASS only if genuinely extensible + ordered + sound — not a thin wrapper or a hardcoded chain.";

const GOOD_DIFF = `+++ b/pricing.ts
+export interface PricingRule { apply(total: number): number; }
+export class PercentOff implements PricingRule {
+  constructor(private pct: number) {}
+  apply(t: number) { return Math.max(0, Math.round(t * (1 - this.pct / 100))); }
+}
+export class FlatFee implements PricingRule {
+  constructor(private cents: number) {}
+  apply(t: number) { return Math.max(0, t - this.cents); }
+}
+export function runPipeline(subtotal: number, rules: PricingRule[]): number {
+  return rules.reduce((total, rule) => rule.apply(total), subtotal);
+}`;

const BAD_DIFF = `+++ b/pricing.ts
+export function computeTotal(subtotal: number, code: string): number {
+  let t = subtotal;
+  if (code === "SAVE10") t = t * 0.9;
+  else if (code === "SAVE25") t = t * 0.75;
+  else if (code === "SHIP") t = t + 500;
+  return t;
+}`;

const GOOD_REPORT = "Added a PricingRule interface with PercentOff and FlatFee rules composed in order via runPipeline (reduce). Ran the tests; all green.";
const BAD_REPORT = "Added computeTotal with the discount codes handled inline. Looks right.";

const good = await gradeJudge(RUBRIC, GOOD_DIFF, GOOD_REPORT);
if (good === null) {
  console.log("judge-selftest: SKIP (no model creds)");
  process.exit(0);
}
const bad = await gradeJudge(RUBRIC, BAD_DIFF, BAD_REPORT);
console.log(`GOOD design → ${good.pass ? "PASS" : "FAIL"} — ${good.reason}`);
console.log(`BAD  design → ${bad?.pass ? "PASS" : "FAIL"} — ${bad?.reason}`);
const ok = good.pass === true && bad?.pass === false;
console.log(ok ? "\x1b[32m✓ judge discriminates\x1b[0m" : "\x1b[31m✗ judge does NOT discriminate\x1b[0m");
process.exit(ok ? 0 : 1);
