package store

// devFallback holds operational config for local dev only. The LIVE values are stored in the
// operational database (table config, in ops/app.db); query it to see what's actually configured in
// a given environment (production overrides these defaults).
var devFallback = map[string]int{
	"max_order_cents": 1000000, // $10,000 in local dev — production sets a much lower limit in the DB
	"max_cart_items":  100,
}

// GetConfig returns an operational config value.
func GetConfig(key string) int {
	return devFallback[key]
}
