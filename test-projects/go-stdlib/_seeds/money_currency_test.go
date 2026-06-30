package store

import "testing"

func TestMoneyFormatPerCurrency(t *testing.T) {
	if got := MoneyOf(1299, "USD").Format(); got != "$12.99" {
		t.Errorf("USD format = %q", got)
	}
	if got := MoneyOf(1299, "EUR").Format(); got != "€12.99" {
		t.Errorf("EUR format = %q", got)
	}
}

func TestMoneyAddSubtract(t *testing.T) {
	sum, err := MoneyOf(1010, "USD").Add(MoneyOf(2030, "USD"))
	if err != nil || sum.Format() != "$30.40" {
		t.Errorf("add: err=%v got=%q", err, sum.Format())
	}
	diff, err := MoneyOf(5000, "USD").Subtract(MoneyOf(1299, "USD"))
	if err != nil || diff.Format() != "$37.01" {
		t.Errorf("subtract: err=%v got=%q", err, diff.Format())
	}
}

func TestMoneyCrossCurrencyErrors(t *testing.T) {
	if _, err := MoneyOf(100, "USD").Add(MoneyOf(100, "EUR")); err == nil {
		t.Error("expected cross-currency add to error")
	}
}

func TestFormatUSDPreserved(t *testing.T) {
	if FormatUSD(1299) != "$12.99" || FormatUSD(0) != "$0.00" {
		t.Error("FormatUSD output changed")
	}
}
