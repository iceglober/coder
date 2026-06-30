package store

import "testing"

func TestFormatUSD(t *testing.T) {
	cases := map[int]string{1299: "$12.99", 1205: "$12.05", 500: "$5.00"}
	for cents, want := range cases {
		if got := FormatUSD(cents); got != want {
			t.Errorf("FormatUSD(%d) = %q, want %q", cents, got, want)
		}
	}
}
