package store

// DiscountCode is a stacking discount. Kind is either "percent" (Value is a
// percentage off the current running total) or "fixed" (Value is a flat number
// of cents to subtract).
type DiscountCode struct {
	Kind  string
	Value int
}

// ApplyCodes applies codes IN ORDER to a running total.
//   - "percent": takes Value percent off the current total. A percent above 100
//     is clamped to 100 (and never negative). The new total is rounded to the
//     nearest cent.
//   - "fixed": subtracts Value cents.
//
// The total never drops below 0.
func ApplyCodes(subtotalCents int, codes []DiscountCode) int {
	total := subtotalCents
	for _, code := range codes {
		switch code.Kind {
		case "percent":
			p := code.Value
			if p < 0 {
				p = 0
			}
			if p > 100 {
				p = 100
			}
			remaining := 100 - p
			// Round to the nearest cent: (total*remaining + 50) / 100.
			total = (total*remaining + 50) / 100
		case "fixed":
			total -= code.Value
		}
		if total < 0 {
			total = 0
		}
	}
	return total
}

// CartTotalAfterCodes applies discount codes to the cart subtotal.
func CartTotalAfterCodes(items []LineItem, codes []DiscountCode) int {
	return ApplyCodes(CartSubtotalCents(items), codes)
}
