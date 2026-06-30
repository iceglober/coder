package store

import "testing"

func TestItemCount(t *testing.T) {
	cart := []LineItem{{Qty: 2, PriceCents: 500}, {Qty: 1, PriceCents: 1299}}
	if got := ItemCount(cart); got != 3 {
		t.Errorf("ItemCount = %d, want 3", got)
	}
}

func TestCartSubtotalCents(t *testing.T) {
	cart := []LineItem{{Qty: 2, PriceCents: 500}, {Qty: 1, PriceCents: 1299}}
	if got := CartSubtotalCents(cart); got != 2299 {
		t.Errorf("CartSubtotalCents = %d, want 2299", got)
	}
}
