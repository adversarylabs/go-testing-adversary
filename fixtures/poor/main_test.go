package sample

import (
	"os"
	"testing"
)

func TestProductionMode(t *testing.T) {
	os.Setenv("MODE", "production")
}
