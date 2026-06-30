"""Seed (Full[Advanced], 2/2): REPLACES test_cart.py. cart_subtotal must return a Money in the
cart's currency (not a raw cents int), and a mixed-currency cart is an error."""
import pytest
from cart import cart_subtotal, item_count
from money import Money

CART = [
    {"qty": 2, "price_cents": 500, "currency": "USD"},
    {"qty": 1, "price_cents": 1299, "currency": "USD"},
]


def test_item_count_preserved():
    assert item_count(CART) == 3


def test_subtotal_returns_money():
    total = cart_subtotal(CART)
    assert isinstance(total, Money)
    assert total.format() == "$22.99"


def test_mixed_currency_raises():
    with pytest.raises(Exception):
        cart_subtotal([
            {"qty": 1, "price_cents": 500, "currency": "USD"},
            {"qty": 1, "price_cents": 500, "currency": "EUR"},
        ])
