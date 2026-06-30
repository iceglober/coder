"""Orders."""
from config import get_config


def create_order(amount_cents: int):
    """Create an order. Amounts over the operational limit (`max_order_cents`) are REJECTED — and the
    rejection is only logged, never surfaced to the caller (returns None). That's why large orders
    appear to "silently fail": the caller sees None; the reason only ever lands in the logs."""
    max_cents = get_config("max_order_cents")
    if amount_cents > max_cents:
        print(f"[orders] rejected: {amount_cents} exceeds max_order_cents={max_cents}")
        return None
    return {"id": f"ord_{amount_cents}", "amount_cents": amount_cents}
