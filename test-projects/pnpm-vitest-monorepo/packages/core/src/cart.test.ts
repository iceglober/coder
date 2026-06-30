import { expect, test } from "vitest";
import { cartSubtotalCents, itemCount } from "./cart.ts";

const cart = [
  { qty: 2, priceCents: 500 },
  { qty: 1, priceCents: 1299 },
];

test("itemCount sums line quantities", () => {
  expect(itemCount(cart)).toBe(3);
  expect(itemCount([])).toBe(0);
});

test("cartSubtotalCents sums qty × unit price", () => {
  expect(cartSubtotalCents(cart)).toBe(2299); // 2*500 + 1299
  expect(cartSubtotalCents([])).toBe(0);
});
