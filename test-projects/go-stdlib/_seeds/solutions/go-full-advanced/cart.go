package store

import "fmt"

// LineItem is one line in a shopping cart.
type LineItem struct {
	Qty        int
	PriceCents int
	Currency   string
}

// ItemCount sums line quantities.
func ItemCount(items []LineItem) int {
	n := 0
	for _, it := range items {
		n += it.Qty
	}
	return n
}

// CartSubtotalCents sums qty * unit price across all lines.
func CartSubtotalCents(items []LineItem) int {
	sum := 0
	for _, it := range items {
		sum += it.Qty * it.PriceCents
	}
	return sum
}

// CartSubtotal sums the cart into a single Money in the cart's currency. A
// mixed-currency cart returns an error; there is no implicit conversion.
func CartSubtotal(items []LineItem) (Money, error) {
	if len(items) == 0 {
		return MoneyOf(0, "USD"), nil
	}
	currency := items[0].Currency
	sum := 0
	for _, it := range items {
		if it.Currency != currency {
			return Money{}, fmt.Errorf("mixed-currency cart: %s and %s", currency, it.Currency)
		}
		sum += it.Qty * it.PriceCents
	}
	return MoneyOf(sum, currency), nil
}
