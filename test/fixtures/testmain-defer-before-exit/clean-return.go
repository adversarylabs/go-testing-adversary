package fixture

import "testing"

func TestMain(m *testing.M) {
	cleanup := startServer()
	defer cleanup()
	m.Run()
}

func startServer() func() {
	return func() {}
}
