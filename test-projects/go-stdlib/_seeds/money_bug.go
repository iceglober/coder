package store

import "fmt"

// FormatUSD formats a whole number of cents as USD, e.g. 1299 -> "$12.99".
func FormatUSD(cents int) string {
	// BUG: drops the cents entirely, so 1299 renders as "$12" not "$12.99".
	return fmt.Sprintf("$%d", cents/100)
}
