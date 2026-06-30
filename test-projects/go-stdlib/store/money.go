package store

import "fmt"

// FormatUSD formats a whole number of cents as USD, e.g. 1299 -> "$12.99".
func FormatUSD(cents int) string {
	return fmt.Sprintf("$%d.%02d", cents/100, cents%100)
}
