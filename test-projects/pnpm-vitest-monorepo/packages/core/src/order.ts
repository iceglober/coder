import { getConfig } from "./config.ts";

export interface Order {
  id: string;
  amountCents: number;
}

/** Create an order. Amounts over the operational limit (`max_order_cents`) are REJECTED — and the
 *  rejection is only logged, never surfaced to the caller (returns null). That's why large orders
 *  appear to "silently fail": the caller sees null, the reason only ever lands in the logs. */
export function createOrder(amountCents: number): Order | null {
  const max = getConfig("max_order_cents");
  if (amountCents > max) {
    console.warn(`[orders] rejected: ${amountCents} exceeds max_order_cents=${max}`);
    return null;
  }
  return { id: `ord_${amountCents}`, amountCents };
}
