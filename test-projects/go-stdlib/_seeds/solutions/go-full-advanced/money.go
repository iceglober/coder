package store

import (
	"fmt"
)

// FormatUSD formats a whole number of cents as USD, e.g. 1299 -> "$12.99".
func FormatUSD(cents int) string {
	return fmt.Sprintf("$%d.%02d", cents/100, cents%100)
}

// Money is a currency-aware amount: a whole number of cents plus a currency
// code (e.g. "USD", "EUR"). It is a value type — operations return new Money.
type Money struct {
	Cents    int
	Currency string
}

// MoneyOf constructs a Money from cents and a currency code.
func MoneyOf(cents int, currency string) Money {
	return Money{Cents: cents, Currency: currency}
}

// Add returns the sum of two Money values. It errors on differing currencies;
// there is no implicit conversion.
func (m Money) Add(other Money) (Money, error) {
	if m.Currency != other.Currency {
		return Money{}, fmt.Errorf("cannot add %s to %s: differing currencies", other.Currency, m.Currency)
	}
	return Money{Cents: m.Cents + other.Cents, Currency: m.Currency}, nil
}

// Subtract returns the difference of two Money values. It errors on differing
// currencies; there is no implicit conversion.
func (m Money) Subtract(other Money) (Money, error) {
	if m.Currency != other.Currency {
		return Money{}, fmt.Errorf("cannot subtract %s from %s: differing currencies", other.Currency, m.Currency)
	}
	return Money{Cents: m.Cents - other.Cents, Currency: m.Currency}, nil
}

// Format renders the amount with a currency-aware symbol, e.g. USD -> "$12.99",
// EUR -> "€12.99".
func (m Money) Format() string {
	symbol := "$"
	switch m.Currency {
	case "EUR":
		symbol = "€"
	case "USD":
		symbol = "$"
	}
	cents := m.Cents
	sign := ""
	if cents < 0 {
		sign = "-"
		cents = -cents
	}
	return fmt.Sprintf("%s%s%d.%02d", sign, symbol, cents/100, cents%100)
}
