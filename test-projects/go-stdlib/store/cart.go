package store

// LineItem is one line in a shopping cart.
type LineItem struct {
	Qty        int
	PriceCents int
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
