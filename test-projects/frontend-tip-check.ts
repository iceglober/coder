#!/usr/bin/env bun
// HIDDEN grader for the frontend-tip task. Lives OUTSIDE the fixture so the agent never sees it: the
// agent has no test suite to run and must self-verify with web_check. This script serves the agent's
// CURRENT files from process.cwd() on its own ephemeral port, renders the page in a real browser
// (system Chrome via Playwright), and asserts the receipt math is right.
//
// A $50 bill with an 18% tip is a $9.00 tip and a $59.00 total. The planted bug omits the /100, so it
// renders a $900.00 tip and a $950.00 total — no error, just wrong. Exit 0 iff the numbers are right.
import { normalize } from "node:path";

const ROOT = process.cwd();

// This grader lives outside the fixture, but playwright is installed in the fixture's node_modules
// (by the task's `bun install` setup). Resolve it from the fixture dir rather than from here.
const { chromium } = (await import(Bun.resolveSync("playwright", ROOT))) as typeof import("playwright");

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/favicon.ico") return new Response(null, { status: 204 });
    const rel = url.pathname === "/" ? "/index.html" : url.pathname;
    const path = normalize(`${ROOT}${rel}`);
    if (!path.startsWith(ROOT)) return new Response("forbidden", { status: 403 });
    const file = Bun.file(path);
    if (!(await file.exists())) return new Response("not found", { status: 404 });
    return new Response(file);
  },
});
const url = `http://localhost:${server.port}`;

function fail(msg: string): never {
  console.error(`frontend-tip-check: ${msg}`);
  server.stop(true);
  process.exit(1);
}

const browser = await chromium.launch({ channel: "chrome" }).catch(() => chromium.launch());
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error" && !m.text().includes("favicon")) errors.push(m.text());
  });
  await page.goto(url, { waitUntil: "networkidle" });
  const tip = (await page.locator("#tip").textContent())?.trim();
  const total = (await page.locator("#total").textContent())?.trim();
  await browser.close();
  server.stop(true);

  const problems: string[] = [];
  if (errors.length) problems.push(`console/page errors: ${errors.join("; ")}`);
  if (tip !== "$9.00") problems.push(`tip is ${JSON.stringify(tip)}, expected "$9.00"`);
  if (total !== "$59.00") problems.push(`total is ${JSON.stringify(total)}, expected "$59.00"`);
  if (problems.length) fail(`FAIL — ${problems.join(" · ")}`);
  console.log("frontend-tip-check: OK — tip $9.00, total $59.00, no errors");
  process.exit(0);
} catch (e) {
  await browser.close().catch(() => {});
  fail(`could not render/verify the page: ${e}`);
}
