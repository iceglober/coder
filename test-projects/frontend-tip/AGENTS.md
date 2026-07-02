# AGENTS.md — frontend-tip

A tiny vanilla-JS receipt page (no framework, no build step), served static.

- `index.html` + `app.js` — render the bill, tip, and grand total once on page load. There is no
  interaction: the numbers are computed and shown as soon as the page opens.
- `serve.ts` — boots a static server on an ephemeral port (`boot()` returns `{ url, stop }`).

There is **no test suite** here. You cannot tell whether the page is right by reading the source —
the bug is in what actually renders. Verify your change by looking at the running page:

1. Start the server (e.g. `bun serve.ts`, or import `boot()` from `serve.ts`).
2. Use the `web_check` tool on that URL to confirm the page renders with no console errors or uncaught
   exceptions, and that the displayed total is what it should be (`web_check` can assert on page text).

Do not just eyeball the code and declare it fixed — render it and check the numbers.
