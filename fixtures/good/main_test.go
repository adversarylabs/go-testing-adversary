package sample

import "testing"

func TestCases(t *testing.T) {
	for _, tc := range []struct{ name string }{{"first"}, {"second"}} {
		t.Run(tc.name, func(t *testing.T) {})
	}
}
