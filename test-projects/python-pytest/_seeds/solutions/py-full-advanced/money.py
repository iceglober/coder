"""Currency-aware money: a Money value type plus the legacy format_usd helper."""

_SYMBOLS = {
    "USD": "$",
    "EUR": "€",
}


class Money:
    """An amount in whole cents tagged with a currency."""

    def __init__(self, cents: int, currency: str):
        self.cents = cents
        self.currency = currency

    @classmethod
    def of(cls, cents: int, currency: str) -> "Money":
        return cls(cents, currency)

    def _require_same_currency(self, other: "Money") -> None:
        if self.currency != other.currency:
            raise ValueError(
                f"currency mismatch: {self.currency} vs {other.currency}"
            )

    def add(self, other: "Money") -> "Money":
        self._require_same_currency(other)
        return Money(self.cents + other.cents, self.currency)

    def subtract(self, other: "Money") -> "Money":
        self._require_same_currency(other)
        return Money(self.cents - other.cents, self.currency)

    def format(self) -> str:
        """Currency-aware formatting, e.g. USD 1299 -> "$12.99", EUR 1299 -> "€12.99"."""
        symbol = _SYMBOLS[self.currency]
        return f"{symbol}{self.cents / 100:.2f}"

    def __eq__(self, other) -> bool:
        return (
            isinstance(other, Money)
            and self.cents == other.cents
            and self.currency == other.currency
        )

    def __repr__(self) -> str:
        return f"Money.of({self.cents}, {self.currency!r})"


def format_usd(cents: int) -> str:
    """Format a whole number of cents as USD, e.g. 1299 -> "$12.99"."""
    return f"${cents / 100:.2f}"
