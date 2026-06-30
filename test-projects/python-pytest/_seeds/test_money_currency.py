"""Seed (Full[Advanced], 1/2): the Money value-type spec. Currency becomes first-class and every
money path must respect it, WITHOUT breaking the existing format_usd."""
import pytest
from money import Money, format_usd


def test_format_per_currency():
    assert Money.of(1299, "USD").format() == "$12.99"
    assert Money.of(1299, "EUR").format() == "€12.99"
    assert Money.of(500, "USD").format() == "$5.00"


def test_add_subtract_same_currency():
    assert Money.of(1010, "USD").add(Money.of(2030, "USD")).format() == "$30.40"
    assert Money.of(5000, "USD").subtract(Money.of(1299, "USD")).format() == "$37.01"


def test_cross_currency_raises():
    with pytest.raises(Exception):
        Money.of(100, "USD").add(Money.of(100, "EUR"))


def test_format_usd_preserved():
    assert format_usd(1299) == "$12.99"
    assert format_usd(0) == "$0.00"
