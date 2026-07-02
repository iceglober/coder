"""Stacking discount codes.

A code is a dict: {"kind": "percent", "value": <pct>} or {"kind": "fixed", "value": <cents>}.
Codes apply IN ORDER to a running total. Percent codes take that percent off the current total
(a percent above 100 is clamped to 100, a negative percent is clamped to 0; the resulting total is
rounded to the nearest cent). Fixed codes subtract a number of cents. The total never drops below 0.
"""

from cart import cart_subtotal_cents


def apply_codes(subtotal_cents: int, codes) -> int:
    """Apply discount codes in order to a running total, flooring at 0 after each step."""
    total = subtotal_cents
    for code in codes:
        kind = code["kind"]
        if kind == "percent":
            pct = max(0, min(code["value"], 100))
            total = round(total * (100 - pct) / 100)
        elif kind == "fixed":
            total = total - code["value"]
        else:
            raise ValueError(f"unknown discount kind: {kind!r}")
        if total < 0:
            total = 0
    return total


def cart_total_after_codes(items, codes) -> int:
    """Apply discount codes to a cart's subtotal."""
    return apply_codes(cart_subtotal_cents(items), codes)
