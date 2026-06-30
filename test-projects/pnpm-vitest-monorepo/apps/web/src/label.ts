/** Render a small count badge for the cart icon, e.g. 3 → "(3)". */
export function countBadge(n: number): string {
  return n > 0 ? `(${n})` : "";
}
