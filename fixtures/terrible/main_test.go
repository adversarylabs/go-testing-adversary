package sample

import (
	"os"
	"testing"
	"time"
)

func TestBackgroundWork(t *testing.T) {
	os.Setenv("MODE", "production")
	go func() { t.Fatal("worker failed") }()
	time.Sleep(time.Second)
}
