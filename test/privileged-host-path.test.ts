import assert from "node:assert/strict";
import test from "node:test";
import { analyzeDiscovery } from "../src/analyze.ts";
import type { SourceRevision } from "../src/types.ts";

const vulnerable = `package sample
import (
  "os"
  "os/exec"
  "path/filepath"
  "testing"
)
func TestHostState(t *testing.T) {
  dir := filepath.Join("/etc/containers/certs.d", "registry")
  _ = exec.Command("mkdir", "-p", dir+"/").Run()
  _ = os.WriteFile(filepath.Join(dir, "ca.crt"), []byte("cert"), 0o600)
  defer exec.Command("rm", "-rf", dir).Run()
}
`;

test("detects direct and command mutations rooted in privileged host trees", async () => {
  const signals = await analyze(vulnerable, "repository", []);
  assert.equal(signals.length, 3);
  assert.deepEqual(signals.map((item) => item.data.operation), ["exec mkdir", "WriteFile", "exec rm"]);
  assert.ok(signals.every((item) => item.ruleId === "go-test.privileged-host-path-mutation"));
  assert.ok(signals.every((item) => item.data.privilegedRoot === "/etc"));
});

test("detects the reviewed Zot mkdir/copy/remove shape", async () => {
  const source = `package sample
import (
  "os/exec"
  "path/filepath"
  "testing"
)
func TestCerts(t *testing.T) {
  temp := t.TempDir()
  privileged := filepath.Join("/etc/containers/certs.d", "127.0.0.1:5000")
  _ = exec.Command("mkdir", "-p", privileged+"/").Run()
  _ = exec.Command("cp", filepath.Join(temp, "ca.crt"), privileged+"/").Run()
  defer exec.Command("rm", "-rf", privileged+"/").Run()
}
`;
  assert.equal((await analyze(source, "repository", [])).length, 3);
});

test("stays quiet for test-owned roots, reads, inert fixtures, and isolated container arguments", async () => {
  const source = `package sample
import (
  "os"
  "os/exec"
  "path/filepath"
  "testing"
)
func TestOwned(t *testing.T) {
  root := t.TempDir()
  fakeEtc := filepath.Join(root, "etc")
  _ = os.WriteFile(filepath.Join(fakeEtc, "config"), nil, 0o600)
  _, _ = os.ReadFile("/etc/hosts")
  _ = exec.Command("cat", "/etc/hosts").Run()
  _ = exec.Command("docker", "run", "image", "rm", "/etc/config").Run()
  fixture := "/etc/containers/certs.d"
  _ = fixture
}
`;
  assert.deepEqual(await analyze(source, "repository", []), []);
});

test("OpenFile requires direct proven write flags and aliases retain provenance", async () => {
  const source = `package sample
import (
  hostos "os"
  "testing"
)
func TestFiles(t *testing.T) {
  _, _ = hostos.OpenFile("/etc/hosts", hostos.O_RDONLY, 0)
  _, _ = hostos.OpenFile("/etc/app/config", hostos.O_CREATE|hostos.O_WRONLY, 0o600)
  flags := hostos.O_CREATE | hostos.O_WRONLY
  _, _ = hostos.OpenFile("/etc/app/bound", flags, 0o600)
  _, _ = hostos.OpenFile("/etc/app/cancelled", hostos.O_CREATE &^ hostos.O_CREATE, 0o600)
}
`;
  const signals = await analyze(source, "repository", []);
  assert.equal(signals.length, 1);
  assert.ok(signals.every((item) => item.data.operation === "OpenFile"));
});

test("requires the command to execute and only treats copy destinations as mutations", async () => {
  const source = `package sample
import (
  "os/exec"
  "testing"
)
func TestCommands(t *testing.T) {
  _ = exec.Command("rm", "/etc/never-executed")
  _ = exec.Command("cp", "/etc/source-only", t.TempDir()).Run()
  _ = exec.Command("cp", t.TempDir()+"/source", "/etc/destination").Run()
  _ = (exec.Command("rm", "/etc/parenthesized")).Run()
  _ = ((exec.Command("rm", "/etc/double-parenthesized"))).Run()
}
`;
  const signals = await analyze(source, "repository", []);
  assert.deepEqual(signals.map((item) => item.data.pathExpression), [
    "/etc/destination", "/etc/parenthesized", "/etc/double-parenthesized",
  ]);
});

test("unwraps parenthesized direct standard-library calls", async () => {
  const source = `package sample
import ("os"; "testing")
func TestParenthesized(t *testing.T) {
  _ = (os.WriteFile)("/etc/write", nil, 0o600)
  _, _ = ((os.OpenFile))("/etc/open", os.O_WRONLY, 0o600)
  _ = os.Chtimes("/etc/times", now, now)
  _ = (os.Chtimes)("/etc/parenthesized-times", now, now)
}
`;
  assert.deepEqual((await analyze(source, "repository", [])).map((item) => item.data.pathExpression), [
    "/etc/write", "/etc/open", "/etc/times", "/etc/parenthesized-times",
  ]);
});

test("fails closed for assigned commands and closures", async () => {
  const source = `package sample
import (
  "fmt"
  "os/exec"
  "testing"
)
func TestCommands(t *testing.T) {
  inert := exec.Command("rm", "/etc/inert")
  fmt.Println("inert.Run()")
  closure := exec.Command("rm", "/etc/closure")
  _ = func() { _ = closure.Run() }
  shadowed := exec.Command("rm", "/etc/shadowed")
  { shadowed := fakeCmd{}; _ = shadowed.Run() }
  real := exec.Command("rm", "/etc/real")
  _ = real.Run()
  immediate := exec.Command("rm", "/etc/immediate")
  func() { _ = immediate.Run() }()
  var declared = exec.Command("rm", "/etc/declared")
  _ = declared.Run()
  original := exec.Command("rm", "/etc/alias")
  alias := original
  _ = alias.Run()
  stored := exec.Command("rm", "/etc/stored")
  run := func() { _ = stored.Run() }
  run()
}
`;
  assert.deepEqual(await analyze(source, "repository", []), []);
});

test("requires every enclosing function literal to be immediately invoked", async () => {
  const source = `package sample
import ("os"; "os/exec"; "testing")
func TestClosures(t *testing.T) {
  storedOS := func() { _ = os.WriteFile("/etc/stored-os", nil, 0o600) }
  _ = storedOS
  storedCommand := func() { _ = exec.Command("rm", "/etc/stored-command").Run() }
  _ = storedCommand
  register(func() { _ = os.Remove("/etc/callback-os") })
  register(func() { _ = exec.Command("rm", "/etc/callback-command").Run() })
  func() { _ = os.Remove("/etc/iife-os") }()
  (func() { _ = exec.Command("rm", "/etc/iife-command").Run() })()
  outer := func() { func() { _ = os.Remove("/etc/nested-stored") }() }
  _ = outer
}
`;
  assert.deepEqual((await analyze(source, "repository", [])).map((item) => item.data.pathExpression), [
    "/etc/iife-os", "/etc/iife-command",
  ]);
});

test("understands target-directory options and does not mistake privileged sources for destinations", async () => {
  const source = `package sample
import (
  "os/exec"
  "testing"
)
func TestTargets(t *testing.T) {
  _ = exec.Command("cp", "-t", t.TempDir(), "/etc/source").Run()
  _ = exec.Command("cp", "-t", "/etc/cp", "source").Run()
  _ = exec.Command("cp", "--target-directory=/etc/long", "source").Run()
  _ = exec.Command("install", "-t", "/usr/local/bin", "tool").Run()
  _ = exec.Command("ln", "--target-directory", "/etc/links", "source").Run()
  _ = exec.Command("cp", "-at", "/etc/combined", "source").Run()
  _ = exec.Command("cp", "-t/etc/attached", "source").Run()
  _ = exec.Command("cp", "-at/etc/combined-attached", "source").Run()
  _ = exec.Command("ln", "-st/etc/link-attached", "source").Run()
  _ = exec.Command("install", "-d", "/etc/install-a", "/usr/local/share/install-b").Run()
  _ = exec.Command("install", "/etc/source.d", t.TempDir()).Run()
  _ = exec.Command("install", "--mode=0600", "/etc/source", t.TempDir()).Run()
  _ = exec.Command("cp", "--", "--target-directory=/etc/not-an-option", t.TempDir()).Run()
  _ = exec.Command("cp", "-St", "/etc/source-suffix", t.TempDir()).Run()
  _ = exec.Command("cp", "-S", "-t", "/etc/source-suffix-arg", t.TempDir()).Run()
  _ = exec.Command("cp", "--suffix", "-t", "/etc/source-long-suffix", t.TempDir()).Run()
  _ = exec.Command("install", "-b", "-S", "-d", "/etc/source-install-suffix", t.TempDir()).Run()
  _ = exec.Command("install", "-b", "--suffix", "-d", "/etc/source-install-long-suffix", t.TempDir()).Run()
  _ = exec.Command("install", "--directory", "/etc/install-long", t.TempDir()).Run()
}
`;
  const signals = await analyze(source, "repository", []);
  assert.deepEqual(signals.map((item) => item.data.pathExpression), [
    "/etc/cp", "/etc/long", "/usr/local/bin", "/etc/links", "/etc/combined", "/etc/attached",
    "/etc/combined-attached", "/etc/link-attached", "/etc/install-a", "/etc/install-long",
  ]);
});

test("does not treat GNU reference sources as mutation targets", async () => {
  const source = `package sample
import ("os/exec"; "testing")
func TestReference(t *testing.T) {
  _ = exec.Command("chmod", "--reference", "/etc/source", t.TempDir()).Run()
  _ = exec.Command("chown", "--reference=/etc/source", t.TempDir()).Run()
  _ = exec.Command("touch", "--reference", "/etc/source", t.TempDir()).Run()
  _ = exec.Command("truncate", "--reference=/etc/source", t.TempDir()).Run()
  _ = exec.Command("touch", "-r", "/etc/source", t.TempDir()).Run()
  _ = exec.Command("truncate", "-r", "/etc/source", t.TempDir()).Run()
  _ = exec.Command("touch", "-cr", "/etc/source", t.TempDir()).Run()
  _ = exec.Command("touch", "-mr", "/etc/source", t.TempDir()).Run()
  _ = exec.Command("truncate", "-cr", "/etc/source", t.TempDir()).Run()
}
`;
  assert.deepEqual(await analyze(source, "repository", []), []);
});

test("only trusts bare or standard-system executable paths", async () => {
  const source = `package sample
import (
  "os/exec"
  "testing"
)
func TestExecutables(t *testing.T) {
  _ = exec.Command("/tmp/rm", "/etc/fake").Run()
  _ = exec.Command("/bin/rm", "/etc/real").Run()
}
`;
  const signals = await analyze(source, "repository", []);
  assert.equal(signals.length, 1);
  assert.equal(signals[0]?.data.pathExpression, "/etc/real");
});

test("normalizes dot segments and stays quiet when a join escapes the privileged root", async () => {
  const source = `package sample
import (
  "os"
  "path/filepath"
  "testing"
)
func TestPaths(t *testing.T) {
  _ = os.WriteFile(filepath.Join("/etc/app", "../../tmp/file"), nil, 0o600)
  _ = os.WriteFile(filepath.Join("/var/lib/app", "../state"), nil, 0o600)
}
`;
  const signals = await analyze(source, "repository", []);
  assert.equal(signals.length, 1);
  assert.equal(signals[0]?.data.privilegedRoot, "/var/lib");
});

test("shadowed standard-library aliases fail closed", async () => {
  const source = `package sample
import (
  "os"
  "os/exec"
  "path/filepath"
  "testing"
)
func TestShadowed(t *testing.T) {
  os := fakeOS{}
  _ = os.WriteFile("/etc/config", nil, 0o600)
  exec := fakeExec{}
  _ = exec.Command("rm", "/etc/config").Run()
  filepath := fakePath{}
  target := filepath.Join("/etc", "config")
  _ = target
}
`;
  assert.deepEqual(await analyze(source, "repository", []), []);
});

test("parameter types do not shadow imports but receiver and result names do", async () => {
  const source = `package sample
import (
  "os"
  "os/exec"
  "testing"
)
func TestTyped(t *testing.T, existing *exec.Cmd, file *os.File) {
  _ = exec.Command("rm", "/etc/command").Run()
  _ = os.WriteFile("/etc/file", nil, 0o600)
}
func (exec fakeRunner) TestReceiver(t *testing.T) { _ = exec.Command("rm", "/etc/receiver").Run() }
func TestResult(t *testing.T) (os fakeOS) { _ = os.WriteFile("/etc/result", nil, 0o600); return }
`;
  const signals = await analyze(source, "repository", []);
  assert.deepEqual(signals.map((item) => item.data.pathExpression), ["/etc/command", "/etc/file"]);
});

test("fails closed when path provenance crosses conditional flow", async () => {
  const source = `package sample
import (
  "os"
  "testing"
)
func TestConditional(t *testing.T) {
  path := t.TempDir()
  if useHost { path = "/etc/conditional" }
  _ = os.WriteFile(path, nil, 0o600)
  replaced := t.TempDir()
  if useHost { replaced = "/etc/overwritten" }
  replaced = t.TempDir()
  _ = os.WriteFile(replaced, nil, 0o600)
  transient := t.TempDir()
  if useHost { transient = "/etc/transient"; transient = t.TempDir() }
  _ = os.WriteFile(transient, nil, 0o600)
}
`;
  assert.deepEqual(await analyze(source, "repository", []), []);
});

test("stays quiet after exhaustive test-owned path replacement", async () => {
  const source = `package sample
import ("os"; "path/filepath"; "testing")
func TestExhaustive(t *testing.T) {
  path := "/etc/legacy"
  if enabled { path = t.TempDir() } else { path = filepath.Join(t.TempDir(), "safe") }
  _ = os.WriteFile(path, nil, 0o600)
  other := "/etc/legacy-switch"
  switch mode { case "a": other = t.TempDir(); default: other = "/tmp/safe" }
  _ = os.WriteFile(other, nil, 0o600)
}
`;
  assert.deepEqual(await analyze(source, "repository", []), []);
});

test("clause-local identifiers shadow imports and outer privileged paths", async () => {
  const source = `package sample
import (
  "os"
  "testing"
)
func TestClauses(t *testing.T) {
  for _, os := range fakeOSes { _ = os.WriteFile("/etc/range", nil, 0o600) }
  if os := fakeOS{}; enabled { _ = os.WriteFile("/etc/if", nil, 0o600) }
  select { case os := <-fakeOSes: _ = os.WriteFile("/etc/select", nil, 0o600); default: }
  path := "/etc/outer"
  for _, path := range []string{t.TempDir()} { _ = os.WriteFile(path, nil, 0o600) }
  if path := t.TempDir(); enabled { _ = os.WriteFile(path, nil, 0o600) }
  switch exec := x.(type) { case fakeExec: _ = exec.Command("rm", "/etc/type-exec").Run() }
  switch path := x.(type) { case string: _ = os.WriteFile(path, nil, 0o600) }
}
`;
  assert.deepEqual(await analyze(source, "repository", []), []);
});

test("fails closed on loop and switch path mutation", async () => {
  const source = `package sample
import ("os"; "testing")
func TestTransfers(t *testing.T) {
  path := t.TempDir()
  for enabled { path = "/etc/loop"; break; path = t.TempDir() }
  _ = os.WriteFile(path, nil, 0o600)
  other := t.TempDir()
  switch { case enabled: other = "/etc/switch"; break; other = t.TempDir() }
  _ = os.WriteFile(other, nil, 0o600)
}
`;
  assert.deepEqual(await analyze(source, "repository", []), []);
});

test("fails closed when path provenance crosses a nested function", async () => {
  const source = `package sample
import ("os"; "testing")
func TestNested(t *testing.T) {
  path := "/etc/stale"
  func() { path = t.TempDir() }()
  _ = os.WriteFile(path, nil, 0o600)
}
`;
  assert.deepEqual(await analyze(source, "repository", []), []);
});

test("does not report a direct command when only a non-target operand changed", async () => {
  const previous = `package sample
import ("os/exec"; "testing")
func TestCopy(t *testing.T) {
  _ = exec.Command("cp",
    "/tmp/source-old",
    "/etc/destination",
  ).Run()
}
`;
  const current = previous.replace("source-old", "source-new");
  const changed = lineOf(current, "source-new");
  assert.deepEqual(await analyze(current, "modified", [changed], previous), []);
});

test("fails closed for variable and conditional OpenFile flags", async () => {
  const source = `package sample
import ("os"; "testing")
func TestFlags(t *testing.T) {
  flags := os.O_RDONLY
  if enabled { flags = os.O_WRONLY }
  _, _ = os.OpenFile("/etc/conditional-flags", flags, 0o600)
}
`;
  assert.deepEqual(await analyze(source, "repository", []), []);
});

test("fails closed for compound flags and assigned command flow", async () => {
  const source = `package sample
import ("os"; "os/exec"; "testing")
func TestFlow(t *testing.T) {
  flags := os.O_WRONLY
  flags &^= os.O_WRONLY
  _, _ = os.OpenFile("/etc/cleared", flags, 0o600)
  cmd := exec.Command("echo", "ok")
  if enabled { cmd = exec.Command("rm", "/etc/conditional-command") }
  _ = cmd.Run()
  stored := exec.Command("rm", "/etc/closure-alias")
  run := func() { _ = stored.Run() }
  invoke := run
  invoke()
}
`;
  assert.deepEqual(await analyze(source, "repository", []), []);
});

test("diff findings anchor the changed path provenance or mutation call", async () => {
  const pathLine = lineOf(vulnerable, 'dir := filepath.Join("/etc/containers/certs.d", "registry")');
  const mkdirLine = lineOf(vulnerable, 'exec.Command("mkdir"');
  const pathSignals = await analyze(vulnerable, "modified", [pathLine]);
  assert.ok(pathSignals.length >= 1);
  assert.ok(pathSignals.every((item) => item.line === pathLine));
  const callSignals = await analyze(vulnerable, "modified", [mkdirLine]);
  assert.equal(callSignals.length, 1);
  assert.equal(callSignals[0]?.line, mkdirLine);
});

test("comment-only edits do not re-report an unchanged privileged mutation", async () => {
  const previous = vulnerable.replace(".Run()\n", ".Run() // old note\n");
  const current = vulnerable.replace(".Run()\n", ".Run() // clearer note\n");
  const changed = lineOf(current, "clearer note");
  assert.deepEqual(await analyze(current, "modified", [changed], previous), []);
});

test("a changed privileged root is new semantic evidence even when the call text is unchanged", async () => {
  const previous = vulnerable.replace("/etc/containers/certs.d", "/tmp/containers/certs.d");
  const changed = lineOf(vulnerable, 'dir := filepath.Join("/etc/containers/certs.d", "registry")');
  const signals = await analyze(vulnerable, "modified", [changed], previous);
  assert.ok(signals.length >= 1);
  assert.ok(signals.every((item) => item.line === changed));
});

test("a changed multiline path operand anchors the semantic continuation line", async () => {
  const previous = `package sample
import ("os"; "path/filepath"; "testing")
func TestPath(t *testing.T) {
  _ = os.WriteFile(filepath.Join(
    "/tmp",
    "app",
  ), nil, 0o600)
}
`;
  const current = previous.replace('"/tmp"', '"/etc"');
  const changed = lineOf(current, '"/etc"');
  const signals = await analyze(current, "modified", [changed], previous);
  assert.equal(signals.length, 1);
  assert.equal(signals[0]?.line, changed);
});

test("a changed assigned-command execution site remains outside the proven subset", async () => {
  const previous = `package sample
import ("os/exec"; "testing")
func TestCommand(t *testing.T) {
  cmd := exec.Command("rm", "/etc/app")
  _ = cmd
}
`;
  const current = previous.replace("_ = cmd", "_ = cmd.Run()");
  const changed = lineOf(current, "cmd.Run()");
  assert.deepEqual(await analyze(current, "modified", [changed], previous), []);
});

async function analyze(
  current: string,
  status: SourceRevision["status"],
  changedLines: number[],
  previous?: string,
) {
  const result = await analyzeDiscovery({
    mode: status === "repository" ? "repository" : "diff",
    files: [{
      path: "sample_test.go",
      current,
      ...(previous === undefined ? {} : { previous }),
      status,
      changedLines: new Set(changedLines),
    }],
  });
  assert.deepEqual(result.parseErrors, []);
  return result.signals.filter((item) => item.ruleId === "go-test.privileged-host-path-mutation");
}

function lineOf(source: string, text: string): number {
  const line = source.split("\n").findIndex((candidate) => candidate.includes(text));
  assert.notEqual(line, -1, text);
  return line + 1;
}
