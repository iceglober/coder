package slug

import "testing"

func TestSlugifyLowercases(t *testing.T) {
	if got := Slugify("Hello World"); got != "hello-world" {
		t.Errorf("Slugify(%q) = %q, want %q", "Hello World", got, "hello-world")
	}
}

func TestSlugifyHyphenatesSpaces(t *testing.T) {
	if got := Slugify("a b c"); got != "a-b-c" {
		t.Errorf("Slugify(%q) = %q, want %q", "a b c", got, "a-b-c")
	}
}
