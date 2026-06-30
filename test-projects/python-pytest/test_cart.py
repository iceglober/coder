from cart import cart_subtotal_cents, item_count

CART = [{"qty": 2, "price_cents": 500}, {"qty": 1, "price_cents": 1299}]


def test_item_count():
    assert item_count(CART) == 3
    assert item_count([]) == 0


def test_subtotal():
    assert cart_subtotal_cents(CART) == 2299
    assert cart_subtotal_cents([]) == 0
