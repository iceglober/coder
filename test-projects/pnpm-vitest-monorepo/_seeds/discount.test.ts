// Seed (Full[Moderate]): the spec for stacking discount codes. The task's `seed` copies this to
// packages/core/src/discount.test.ts before the commit. Mid-level: the rules (running total, order
// dependence, floor at 0, percent clamp, rounding) + wiring into the cart take real care.
import { expect, test } from "vitest";
import { applyCodes, cartTotalAfterCodes, type DiscountCode } from "./discount.ts";

const pct = (value: number): DiscountCode => ({ kind: "percent", value });
const fixed = (value: number): DiscountCode => ({ kind: "fixed", value });

test("no codes returns the subtotal unchanged", () => {
  expect(applyCodes(2000, [])).toBe(2000);
});

test("a percent code takes that percent off", () => {
  expect(applyCodes(2000, [pct(10)])).toBe(1800);
});

test("a fixed code subtracts cents", () => {
  expect(applyCodes(2000, [fixed(500)])).toBe(1500);
});

test("codes stack IN ORDER (percent-then-fixed differs from fixed-then-percent)", () => {
  expect(applyCodes(2000, [pct(10), fixed(500)])).toBe(1300); // 2000 → 1800 → 1300
  expect(applyCodes(2000, [fixed(500), pct(10)])).toBe(1350); // 2000 → 1500 → 1350
});

test("the total never goes below zero", () => {
  expect(applyCodes(1000, [fixed(1500)])).toBe(0);
  expect(applyCodes(1000, [fixed(1500), pct(50)])).toBe(0);
});

test("a percent over 100 is clamped to 100% (free, never negative)", () => {
  expect(applyCodes(2000, [pct(150)])).toBe(0);
});

test("percent discounts round to the nearest cent", () => {
  expect(applyCodes(1299, [pct(33)])).toBe(870); // 1299 - 428.67 = 870.33 → 870
});

test("cartTotalAfterCodes applies codes to the cart subtotal", () => {
  const cart = [
    { qty: 2, priceCents: 500 },
    { qty: 1, priceCents: 1299 },
  ]; // subtotal 2299
  expect(cartTotalAfterCodes(cart, [pct(10)])).toBe(2069); // 2299 * 0.9 = 2069.1 → 2069
});
