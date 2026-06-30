/** A line in a shopping cart. */
export interface LineItem {
  qty: number;
  priceCents: number;
}

/** Total number of items in a cart (sum of line quantities). */
export function itemCount(items: { qty: number }[]): number {
  return items.reduce((n, item) => n + item.qty, 0);
}

/** Cart subtotal in cents: sum of qty × unit price across all lines. */
export function cartSubtotalCents(items: LineItem[]): number {
  return items.reduce((sum, item) => sum + item.qty * item.priceCents, 0);
}
