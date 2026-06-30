from money import format_usd


def test_formats_dollars_and_cents():
    assert format_usd(1299) == "$12.99"


def test_pads_cents():
    assert format_usd(1205) == "$12.05"


def test_whole_dollars():
    assert format_usd(500) == "$5.00"
