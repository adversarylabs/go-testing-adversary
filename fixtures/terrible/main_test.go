package sample

import (
	"os"
	"testing"
	"time"
)

func TestMain(m *testing.M) {
	// Forgot m.Run() — tests never execute.
	os.Setenv("MODE", "setup")
}

func TestBackgroundWork(t *testing.T) {
	os.Setenv("MODE", "production")
	go func() { t.Fatal("worker failed") }()
	time.Sleep(time.Second)
}

func TestLegacy(t *testing.T) {
	t.Skip("disabled")
}
