package store

import "testing"

func pct(v int) DiscountCode   { return DiscountCode{Kind: "percent", Value: v} }
func fixedC(v int) DiscountCode { return DiscountCode{Kind: "fixed", Value: v} }

func TestApplyCodes(t *testing.T) {
	cases := []struct {
		name     string
		subtotal int
		codes    []DiscountCode
		want     int
	}{
		{"no codes", 2000, nil, 2000},
		{"percent", 2000, []DiscountCode{pct(10)}, 1800},
		{"fixed", 2000, []DiscountCode{fixedC(500)}, 1500},
		{"stack pct then fixed", 2000, []DiscountCode{pct(10), fixedC(500)}, 1300},
		{"stack fixed then pct", 2000, []DiscountCode{fixedC(500), pct(10)}, 1350},
		{"floor at zero", 1000, []DiscountCode{fixedC(1500)}, 0},
		{"percent clamp", 2000, []DiscountCode{pct(150)}, 0},
		{"rounding", 1299, []DiscountCode{pct(33)}, 870},
	}
	for _, c := range cases {
		if got := ApplyCodes(c.subtotal, c.codes); got != c.want {
			t.Errorf("%s: ApplyCodes(%d) = %d, want %d", c.name, c.subtotal, got, c.want)
		}
	}
}

func TestCartTotalAfterCodes(t *testing.T) {
	cart := []LineItem{{Qty: 2, PriceCents: 500}, {Qty: 1, PriceCents: 1299}}
	if got := CartTotalAfterCodes(cart, []DiscountCode{pct(10)}); got != 2069 {
		t.Errorf("CartTotalAfterCodes = %d, want 2069", got)
	}
}
