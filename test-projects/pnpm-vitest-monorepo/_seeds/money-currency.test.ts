// Seed (Full[Advanced], part 1/2): the Money value-type spec. Cross-cutting: currency becomes a
// first-class concept and every money path must respect it, WITHOUT breaking the existing formatUSD.
import { expect, test } from "vitest";
import { formatUSD, Money } from "./money.ts";

test("Money.of formats per currency (symbol + 2 decimals)", () => {
  expect(Money.of(1299, "USD").format()).toBe("$12.99");
  expect(Money.of(1299, "EUR").format()).toBe("€12.99");
  expect(Money.of(500, "USD").format()).toBe("$5.00");
});

test("same-currency add and subtract", () => {
  expect(Money.of(1010, "USD").add(Money.of(2030, "USD")).format()).toBe("$30.40");
  expect(Money.of(5000, "USD").subtract(Money.of(1299, "USD")).format()).toBe("$37.01");
});

test("cross-currency arithmetic throws (no implicit conversion)", () => {
  expect(() => Money.of(100, "USD").add(Money.of(100, "EUR"))).toThrow();
  expect(() => Money.of(100, "USD").subtract(Money.of(100, "EUR"))).toThrow();
});

test("formatUSD is preserved — same output as before the migration", () => {
  expect(formatUSD(1299)).toBe("$12.99");
  expect(formatUSD(0)).toBe("$0.00");
});
