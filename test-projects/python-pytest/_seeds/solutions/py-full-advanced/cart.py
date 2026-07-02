"""Shopping cart."""

from money import Money


def item_count(items) -> int:
    """Total number of items (sum of line quantities)."""
    return sum(item["qty"] for item in items)


def cart_subtotal(items) -> Money:
    """Cart subtotal as a Money in the cart's currency.

    Each line carries its own currency; a mixed-currency cart raises.
    """
    total = None
    for item in items:
        line = Money.of(item["qty"] * item["price_cents"], item["currency"])
        total = line if total is None else total.add(line)
    return total
