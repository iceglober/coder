import { afterAll, beforeAll, expect, test } from "bun:test";
import { type Browser, chromium } from "playwright";
import { boot } from "../serve";

let server: ReturnType<typeof boot>;
let browser: Browser;

beforeAll(async () => {
  server = boot();
  // Use the system Chrome so no Playwright browser download is needed.
  browser = await chromium.launch({ channel: "chrome" }).catch(() => chromium.launch());
});
afterAll(async () => {
  await browser.close();
  server.stop();
});

async function open() {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error" && !m.text().includes("favicon")) errors.push(m.text());
  });
  await page.goto(server.url, { waitUntil: "networkidle" });
  return { page, errors };
}

test("adding items updates the subtotal", async () => {
  const { page, errors } = await open();
  await page.click('[data-add="WIDGET"]');
  await page.click('[data-add="GADGET"]');
  expect(await page.locator("#subtotal").textContent()).toBe("$35.00");
  expect(errors).toEqual([]);
});

test("applying SAVE10 takes 10% off the total", async () => {
  const { page, errors } = await open();
  await page.click('[data-add="WIDGET"]'); // $10.00
  await page.fill("#code", "SAVE10");
  await page.click("#apply");
  // 10% off $10.00 = $9.00
  expect(await page.locator("#total").textContent()).toBe("$9.00");
  expect(errors).toEqual([]);
});

test("applying SAVE25 to a $25 gadget shows $18.75", async () => {
  const { page, errors } = await open();
  await page.click('[data-add="GADGET"]'); // $25.00
  await page.fill("#code", "SAVE25");
  await page.click("#apply");
  expect(await page.locator("#total").textContent()).toBe("$18.75");
  expect(errors).toEqual([]);
});
