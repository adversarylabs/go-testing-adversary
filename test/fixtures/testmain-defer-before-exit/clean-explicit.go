package fixture

import (
	"os"
	"testing"
)

func TestMain(m *testing.M) {
	cleanup := startServer()
	code := m.Run()
	cleanup()
	os.Exit(code)
}

func startServer() func() {
	return func() {}
}
