//! `web_check` — the browser self-verification tool. A text model can't *see* a page, so this drives
//! a headless browser and returns the things a page can be wrong about that are otherwise invisible:
//! console errors, uncaught exceptions, failed network requests, and whether expected text/selectors
//! are actually present. Self-contained: a bundled Bun + Playwright driver `bun -e`'d against the URL
//! (no files written), using the system Chrome (`channel: "chrome"`) so no browser download is needed.

use crate::exec::run;
use crate::tools::ToolOutcome;
use serde_json::Value;
use std::path::Path;
use std::time::Duration;

/// The driver body — evaluated via `bun -e` with the args JSON prepended as `const args = …`, so it
/// resolves Playwright from the project's `node_modules` without writing any file. Emits one JSON line.
const DRIVER_BODY: &str = r#"import { chromium } from "playwright";
const out = { url: args.url, ok: true, title: "", consoleErrors: [], pageErrors: [], failedRequests: [], checks: [] };
let browser;
try {
  browser = await chromium.launch({ channel: "chrome" }).catch(() => chromium.launch());
  const page = await browser.newPage();
  const ignore = (u) => u.includes("favicon.ico"); // browser auto-requests it; a 404 here is noise
  // "Failed to load resource" console errors are network failures — reported via the response handler
  // below (which favicon-filters), so drop them here to avoid double-counting and favicon noise.
  page.on("console", (m) => { if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) out.consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => out.pageErrors.push(String(e)));
  page.on("response", (r) => { if (r.status() >= 400 && !ignore(r.url())) out.failedRequests.push(r.status() + " " + r.url()); });
  const resp = await page.goto(args.url, { waitUntil: "networkidle", timeout: args.timeoutMs ?? 15000 });
  if (resp && resp.status() >= 400) out.failedRequests.push(resp.status() + " " + args.url);
  if (args.waitFor) { try { await page.waitForSelector(args.waitFor, { timeout: 5000 }); } catch { out.checks.push({ kind: "waitFor", target: args.waitFor, ok: false }); } }
  out.title = await page.title();
  if (args.expectSelector) { const n = await page.locator(args.expectSelector).count(); out.checks.push({ kind: "selector", target: args.expectSelector, ok: n > 0, count: n }); }
  if (args.expectText) { const body = await page.locator("body").innerText().catch(() => ""); out.checks.push({ kind: "text", target: args.expectText, ok: body.includes(args.expectText) }); }
} catch (e) {
  out.ok = false; out.error = String(e);
} finally {
  if (browser) await browser.close();
}
out.ok = out.ok && !out.error && out.consoleErrors.length === 0 && out.pageErrors.length === 0 && out.failedRequests.length === 0 && out.checks.every((c) => c.ok);
console.log(JSON.stringify(out));
"#;

/// Run a browser check against `args.url`. Never errors out of the call (per the tools convention);
/// an unreachable page or a missing toolchain comes back as readable text with `ok = false`.
pub async fn web_check(root: &Path, args: &Value) -> ToolOutcome {
    let url = match args.get("url").and_then(|v| v.as_str()) {
        Some(u) if !u.is_empty() => u,
        _ => return ToolOutcome::err("error: web_check needs a `url` (e.g. http://localhost:5173)"),
    };
    // Availability probe — a clear, actionable message beats an opaque spawn error.
    if run(&["bun", "--version"], &root.to_string_lossy(), None)
        .await
        .map(|o| o.exit_code != 0)
        .unwrap_or(true)
    {
        return ToolOutcome::err(
            "error: web_check needs `bun` on PATH (it drives a headless browser via Playwright).",
        );
    }

    let payload = serde_json::json!({
        "url": url,
        "waitFor": args.get("wait_for").and_then(|v| v.as_str()),
        "expectSelector": args.get("expect_selector").and_then(|v| v.as_str()),
        "expectText": args.get("expect_text").and_then(|v| v.as_str()),
        "timeoutMs": args.get("timeout_s").and_then(|v| v.as_u64()).map(|s| (s * 1000).clamp(1000, 60_000)),
    });
    // JSON is valid JS — embed the args so no file or argv marshalling is needed.
    let code = format!("const args = {payload};\n{DRIVER_BODY}");

    let out = match run(
        &["bun", "-e", &code],
        &root.to_string_lossy(),
        Some(Duration::from_secs(90)),
    )
    .await
    {
        Ok(o) => o,
        Err(e) => return ToolOutcome::err(format!("error: web_check failed to launch: {e}")),
    };

    // The driver prints one JSON line on stdout; a resolution/install failure lands on stderr.
    let line = out.stdout.lines().rev().find(|l| l.trim_start().starts_with('{'));
    match line.and_then(|l| serde_json::from_str::<Value>(l).ok()) {
        Some(report) => summarize(&report),
        None => {
            let stderr = out.stderr.trim();
            if stderr.contains("Cannot find") && stderr.contains("playwright") {
                ToolOutcome::err(
                    "error: web_check needs Playwright — run `bun add -d playwright` in this project (Chrome or `bunx playwright install chromium` must also be available).",
                )
            } else {
                ToolOutcome::err(format!(
                    "error: web_check got no result. Is the URL serving? stderr: {}",
                    first_lines(stderr, 3)
                ))
            }
        }
    }
}

fn first_lines(s: &str, n: usize) -> String {
    s.lines().take(n).collect::<Vec<_>>().join(" | ")
}

/// Turn the driver's JSON into a compact report the model can act on, and set `ok`.
fn summarize(r: &Value) -> ToolOutcome {
    let ok = r.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
    let mut lines = Vec::new();
    let title = r.get("title").and_then(|v| v.as_str()).unwrap_or("");
    lines.push(format!(
        "{} {} — title: {:?}",
        if ok { "✓ page ok" } else { "✗ page problem" },
        r.get("url").and_then(|v| v.as_str()).unwrap_or(""),
        title
    ));
    if let Some(e) = r.get("error").and_then(|v| v.as_str()) {
        lines.push(format!("load error: {}", first_lines(e, 2)));
    }
    let list = |key: &str, label: &str, lines: &mut Vec<String>| {
        if let Some(arr) = r.get(key).and_then(|v| v.as_array()) {
            for item in arr.iter().filter_map(|v| v.as_str()).take(10) {
                lines.push(format!("{label}: {item}"));
            }
        }
    };
    list("pageErrors", "uncaught exception", &mut lines);
    list("consoleErrors", "console.error", &mut lines);
    list("failedRequests", "failed request", &mut lines);
    if let Some(checks) = r.get("checks").and_then(|v| v.as_array()) {
        for c in checks {
            let ck = c.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
            lines.push(format!(
                "{} {} {:?}",
                if ck { "assert ok" } else { "assert FAILED" },
                c.get("kind").and_then(|v| v.as_str()).unwrap_or("?"),
                c.get("target").and_then(|v| v.as_str()).unwrap_or("")
            ));
        }
    }
    let text = lines.join("\n");
    if ok {
        ToolOutcome::ok(text)
    } else {
        ToolOutcome::err(text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn summarize_flags_console_errors_as_not_ok() {
        let r = serde_json::json!({
            "url": "http://localhost:1", "ok": false, "title": "App",
            "consoleErrors": ["TypeError: x is undefined"], "pageErrors": [],
            "failedRequests": ["500 http://localhost:1/api"], "checks": [{"kind":"text","target":"Total","ok":false}]
        });
        let o = summarize(&r);
        assert!(!o.ok);
        assert!(o.text.contains("console.error: TypeError"));
        assert!(o.text.contains("failed request: 500"));
        assert!(o.text.contains("assert FAILED text"));
    }

    #[test]
    fn summarize_reports_a_clean_page_as_ok() {
        let r = serde_json::json!({
            "url": "http://localhost:5173", "ok": true, "title": "Store",
            "consoleErrors": [], "pageErrors": [], "failedRequests": [],
            "checks": [{"kind":"selector","target":"#cart","ok":true,"count":1}]
        });
        let o = summarize(&r);
        assert!(o.ok);
        assert!(o.text.contains("✓ page ok"));
        assert!(o.text.contains("assert ok selector"));
    }
}
