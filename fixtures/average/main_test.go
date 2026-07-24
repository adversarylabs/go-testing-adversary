package sample

import (
	"testing"
	"time"
)

func TestEventuallyReady(t *testing.T) {
	time.Sleep(250 * time.Millisecond)
}
