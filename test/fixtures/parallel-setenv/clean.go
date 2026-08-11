package fixture

import "testing"

func TestSerialEnvironment(t *testing.T) {
	t.Setenv("API_ENDPOINT", "fixture")
}

func TestParallelWithoutEnvironment(t *testing.T) {
	t.Parallel()
}

func TestParentEnvironmentWithParallelChild(t *testing.T) {
	t.Setenv("API_ENDPOINT", "shared-read-only-value")
	t.Run("parallel child", func(tb *testing.T) {
		tb.Parallel()
	})
}

func TestMutuallyExclusiveModes(t *testing.T) {
	if testing.Short() {
		t.Setenv("MODE", "short")
		return
	}
	t.Parallel()
}
