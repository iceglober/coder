// Seed (Full[Advanced], part 2/2): REPLACES cart.test.ts. The cart must become currency-aware —
// `cartSubtotal` returns a Money (not a raw cents number), and a mixed-currency cart is an error.
// This forces the Money migration to reach the cart, not just live alongside it.
import { expect, test } from "vitest";
import { cartSubtotal, itemCount } from "./cart.ts";
import { Money } from "./money.ts";

const cart = [
  { qty: 2, priceCents: 500, currency: "USD" },
  { qty: 1, priceCents: 1299, currency: "USD" },
];

test("itemCount still sums line quantities", () => {
  expect(itemCount(cart)).toBe(3);
});

test("cartSubtotal returns a Money in the cart's currency", () => {
  const total = cartSubtotal(cart);
  expect(total).toBeInstanceOf(Money);
  expect(total.format()).toBe("$22.99"); // 2*500 + 1299 = 2299
});

test("a mixed-currency cart is rejected", () => {
  expect(() =>
    cartSubtotal([
      { qty: 1, priceCents: 500, currency: "USD" },
      { qty: 1, priceCents: 500, currency: "EUR" },
    ]),
  ).toThrow();
});
