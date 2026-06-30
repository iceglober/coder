"""Shopping cart."""


def item_count(items) -> int:
    """Total number of items (sum of line quantities)."""
    return sum(item["qty"] for item in items)


def cart_subtotal_cents(items) -> int:
    """Cart subtotal in cents: sum of qty * unit price across all lines."""
    return sum(item["qty"] * item["price_cents"] for item in items)
