package fixture

import (
	"os"
	"testing"
)

func TestMain(m *testing.M) {
	os.Exit(runTestMain(m))
}

func runTestMain(m *testing.M) int {
	cleanup := startServer()
	defer cleanup()
	return m.Run()
}

func startServer() func() {
	return func() {}
}
