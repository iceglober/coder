package store

import "testing"

func TestCartSubtotalCurrency(t *testing.T) {
	cart := []LineItem{
		{Qty: 2, PriceCents: 500, Currency: "USD"},
		{Qty: 1, PriceCents: 1299, Currency: "USD"},
	}
	total, err := CartSubtotal(cart)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if total.Format() != "$22.99" {
		t.Errorf("CartSubtotal = %q, want $22.99", total.Format())
	}
}

func TestCartSubtotalMixedCurrencyErrors(t *testing.T) {
	cart := []LineItem{
		{Qty: 1, PriceCents: 500, Currency: "USD"},
		{Qty: 1, PriceCents: 500, Currency: "EUR"},
	}
	if _, err := CartSubtotal(cart); err == nil {
		t.Error("expected mixed-currency cart to error")
	}
}
