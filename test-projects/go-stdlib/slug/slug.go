package slug

import "strings"

// Slugify turns a title like "Hello World" into a URL slug like "hello-world".
func Slugify(s string) string {
	// BUG: spaces are hyphenated but the case is never lowered, so "Hello World" → "Hello-World".
	return strings.ReplaceAll(s, " ", "-")
}
