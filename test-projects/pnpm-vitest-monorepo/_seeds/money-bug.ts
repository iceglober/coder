// Seed for the `ts-fix-failing-test` task: the buggy formatUSD. The task's `seed` copies this over
// packages/core/src/money.ts before the commit, so coder faces a real failing test to diagnose + fix.
/** Format a whole number of cents as a USD string, e.g. 1299 → "$12.99". */
export function formatUSD(cents: number): string {
  // BUG: integer-divides away the cents, so 1299 renders as "$12" not "$12.99".
  const dollars = Math.floor(cents / 100);
  return `$${dollars}`;
}
