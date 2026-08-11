package fixture

import "testing"

func TestParallelEnvironment(t *testing.T) {
	t.Parallel()
	t.Setenv("API_ENDPOINT", "fixture")
}

func TestParallelSubtests(t *testing.T) {
	t.Run("setenv first", func(tb *testing.T) {
		tb.Setenv("REGION", "test")
		tb.Parallel()
	})
}
