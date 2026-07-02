"""Currency formatting."""


def format_usd(cents: int) -> str:
    """Format a whole number of cents as USD, e.g. 1299 -> "$12.99"."""
    return f"${cents / 100:.2f}"
