package sample

import (
	"os"
	"testing"
)

func TestMain(m *testing.M) {
	// setup only — never runs package tests
	os.Setenv("MODE", "setup")
}
