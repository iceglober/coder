"""Seed (Full[Moderate]): the spec for stacking discount codes. The task's seed copies this to
test_discount.py before the commit; it fails until coder implements a `discount` module."""
from discount import apply_codes, cart_total_after_codes


def pct(v):
    return {"kind": "percent", "value": v}


def fixed(v):
    return {"kind": "fixed", "value": v}


def test_no_codes_unchanged():
    assert apply_codes(2000, []) == 2000


def test_percent():
    assert apply_codes(2000, [pct(10)]) == 1800


def test_fixed():
    assert apply_codes(2000, [fixed(500)]) == 1500


def test_stacking_is_order_dependent():
    assert apply_codes(2000, [pct(10), fixed(500)]) == 1300  # 2000 -> 1800 -> 1300
    assert apply_codes(2000, [fixed(500), pct(10)]) == 1350  # 2000 -> 1500 -> 1350


def test_floors_at_zero():
    assert apply_codes(1000, [fixed(1500)]) == 0
    assert apply_codes(1000, [fixed(1500), pct(50)]) == 0


def test_percent_over_100_clamped():
    assert apply_codes(2000, [pct(150)]) == 0


def test_percent_rounds_to_nearest_cent():
    assert apply_codes(1299, [pct(33)]) == 870  # 1299 - 428.67 -> 870.33 -> 870


def test_cart_total_after_codes():
    cart = [{"qty": 2, "price_cents": 500}, {"qty": 1, "price_cents": 1299}]  # subtotal 2299
    assert cart_total_after_codes(cart, [pct(10)]) == 2069  # 2299 * 0.9 = 2069.1 -> 2069
