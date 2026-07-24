package sample

import "testing"

func TestConfigured(t *testing.T) {
	t.Setenv("MODE", "test")
	t.Cleanup(func() {})
}
