package store

import "fmt"

// Order is a placed order.
type Order struct {
	ID          string
	AmountCents int
}

// CreateOrder rejects amounts over the operational limit (max_order_cents). The rejection is only
// logged, never returned (returns nil), so large orders appear to "silently fail": the caller sees
// nil; the reason only ever lands in the logs.
func CreateOrder(amountCents int) *Order {
	max := GetConfig("max_order_cents")
	if amountCents > max {
		fmt.Printf("[orders] rejected: %d exceeds max_order_cents=%d\n", amountCents, max)
		return nil
	}
	return &Order{ID: fmt.Sprintf("ord_%d", amountCents), AmountCents: amountCents}
}
