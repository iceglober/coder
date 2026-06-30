/** Format a whole number of cents as a USD string, e.g. 1299 → "$12.99". */
export function formatUSD(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
