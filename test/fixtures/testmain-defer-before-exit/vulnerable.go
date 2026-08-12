package fixture

import (
	"os"
	"testing"
)

func TestMain(m *testing.M) {
	cleanup := startServer()
	defer cleanup()
	os.Exit(m.Run())
}

func startServer() func() {
	return func() {}
}
