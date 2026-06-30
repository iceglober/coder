"""Currency formatting."""


def format_usd(cents: int) -> str:
    """Format a whole number of cents as USD, e.g. 1299 -> "$12.99"."""
    # BUG: integer-divides away the cents, so 1299 renders as "$12" not "$12.99".
    dollars = cents // 100
    return f"${dollars}"
