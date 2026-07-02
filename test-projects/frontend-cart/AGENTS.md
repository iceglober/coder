# AGENTS.md — frontend-cart

A tiny vanilla-JS storefront (no framework, no build step), served static.

- `index.html` + `app.js` — the cart UI and its logic (add items, apply a percent discount code).
- `serve.ts` — boots a static server on an ephemeral port (`boot()` returns `{ url, stop }`).
- `e2e/cart.test.ts` — end-to-end tests that serve the page and drive a **real browser**
  (Playwright + the system Chrome via `channel: "chrome"`), asserting the rendered DOM.

Run the e2e suite: `bun test e2e` (needs `bun`, Playwright, and Chrome/Chromium).

This is UI work: you cannot see the page from the source. Verify changes by running the e2e suite, or
start the server and use the `web_check` tool to confirm it renders with no console errors, failed
requests, or uncaught exceptions.
