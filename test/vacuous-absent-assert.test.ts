import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApp } from "../src/index.ts";

const ruleId = "go-test.vacuous-absent-assert";

test("flags a leak assertion whose sentinel is not in the fixture", async () => {
  const output = await review({
    "zypper_install_test.go": `package distro

import (
	"strings"
	"testing"
)

func TestProxyDoesNotLeak(t *testing.T) {
	proxy := "http://proxy.example:8080"
	out := runWithXtrace(proxy)
	if strings.Contains(out, "secret") {
		t.Fatalf("proxy leaked: %s", out)
	}
}

func runWithXtrace(string) string { return "" }
`,
  });
  const finding = output.findings.find((item) => item.ruleId === ruleId);
  assert.ok(finding, JSON.stringify(output.findings, null, 2));
  assert.equal(finding.severity, "high");
  assert.ok(finding.evidence.some((item) => item.location?.line === 11));
});

test("stays quiet when the sentinel is actually in the configured value", async () => {
  const output = await review({
    "zypper_install_test.go": `package distro

import (
	"strings"
	"testing"
)

func TestProxyDoesNotLeak(t *testing.T) {
	proxy := "http://user:sentinel-secret@proxy.example:8080"
	out := runWithXtrace(proxy)
	if strings.Contains(out, "sentinel-secret") {
		t.Fatalf("proxy leaked: %s", out)
	}
}

func runWithXtrace(string) string { return "" }
`,
  });
  assert.equal(output.findings.some((item) => item.ruleId === ruleId), false);
});

test("stays quiet on ordinary NotContains that is not a leak test", async () => {
  const output = await review({
    "msg_test.go": `package sample

import (
	"strings"
	"testing"
)

func TestErrorMessage(t *testing.T) {
	err := doWork()
	if strings.Contains(err.Error(), "unexpected") {
		t.Fatal(err)
	}
}

func doWork() error { return nil }
`,
  });
  assert.equal(output.findings.some((item) => item.ruleId === ruleId), false);
});

async function review(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "go-testing-vacuous-"));
  for (const [path, content] of Object.entries(files)) await writeFile(join(root, path), content);
  return createApp().run({ input: { source: { path: root } } });
}
