import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("the published runtime executes without node_modules", async () => {
  const artifact = await mkdtemp(join(tmpdir(), "go-testing-artifact-"));
  const repository = await mkdtemp(join(tmpdir(), "go-testing-target-"));
  const entrypoint = join(artifact, "dist", "index.js");
  const input = join(artifact, "input.json");
  const output = join(artifact, "output.json");

  await mkdir(dirname(entrypoint), { recursive: true });
  await mkdir(join(artifact, "schemas"), { recursive: true });
  await copyFile(join(projectRoot, "dist", "index.js"), entrypoint);
  await copyFile(join(projectRoot, "dist", "web-tree-sitter.wasm"), join(artifact, "dist", "web-tree-sitter.wasm"));
  await copyFile(join(projectRoot, "dist", "tree-sitter-go.wasm"), join(artifact, "dist", "tree-sitter-go.wasm"));
  await copyFile(
    join(projectRoot, "schemas", "adversary.review.v1.schema.json"),
    join(artifact, "schemas", "adversary.review.v1.schema.json"),
  );
  await copyFile(join(projectRoot, "THIRD_PARTY_NOTICES.md"), join(artifact, "THIRD_PARTY_NOTICES.md"));
  await writeFile(join(artifact, "package.json"), '{"type":"module"}\n');
  await writeFile(join(repository, "main.go"), "package sample\n\nfunc ready() bool { return true }\n");
  const vulnerable = join(repository, "metadata_test.go");
  await writeFile(vulnerable, `package sample
import (
  "testing"
  "connectrpc.com/connect/internal/assert"
)
func TestResponseMetadata(t *testing.T) {
  info := newCallInfo()
  headerValue := info.ResponseHeader().Get("x-header")
  assert.Equal(t, headerValue, "header")
  trailerValue := info.ResponseTrailer().Get("x-trailer")
  assert.Equal(t, trailerValue, "trailer")
}
`);
  await writeFile(input, `${JSON.stringify({ source: { path: repository } })}\n`);

  const bundle = await readFile(entrypoint, "utf8");
  assert.doesNotMatch(bundle, /from\s+["'](?:@adversarylabs\/sdk|web-tree-sitter)["']/);
  assert.doesNotMatch(bundle, /\/Users\/marc|\/private\/tmp\/go-testing-issue14/);
  const notices = await readFile(join(artifact, "THIRD_PARTY_NOTICES.md"), "utf8");
  assert.deepEqual([...notices.matchAll(/^## (.+?) \(/gm)].map((match) => match[1]), [
    "@adversarylabs/sdk",
    "ajv",
    "fast-deep-equal",
    "fast-uri",
    "json-schema-traverse",
    "tree-sitter-go",
    "web-tree-sitter",
    "yaml",
  ]);
  assert.match(notices, /Permission is hereby granted/);
  assert.match(notices, /Redistribution and use in source and binary forms/);
  assert.match(notices, /Copyright \(c\) 2014 Max Brunsfeld/);

  await execute(process.execPath, [entrypoint], {
    cwd: artifact,
    env: {
      ...process.env,
      ADVERSARY_INPUT: input,
      ADVERSARY_OUTPUT: output,
      ADVERSARY_REPO: repository,
    },
  });

  const envelope = JSON.parse(await readFile(output, "utf8"));
  assert.equal(envelope.protocolVersion, 1);
  assert.equal(envelope.result.adversary.name, "go/testing");
  assert.equal(envelope.result.adversary.version, "0.0.18");
  assert.equal(envelope.result.findings.length, 1);
  assert.equal(envelope.result.findings[0]?.ruleId, "go-test.partition-boundary-oracle");

  await rm(vulnerable);
  await execute(process.execPath, [entrypoint], {
    cwd: artifact,
    env: {
      ...process.env,
      ADVERSARY_INPUT: input,
      ADVERSARY_OUTPUT: output,
      ADVERSARY_REPO: repository,
    },
  });
  const cleanEnvelope = JSON.parse(await readFile(output, "utf8"));
  assert.deepEqual(cleanEnvelope.result.findings, []);
});

test("the catalog package excludes repository and dependency metadata", async () => {
  const ignore = await readFile(join(projectRoot, ".adversaryignore"), "utf8");
  const patterns = new Set(ignore.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  assert.equal(patterns.has(".git"), true);
  assert.equal(patterns.has("node_modules/"), true);

  for (const path of [
    "dist/index.js",
    "schemas/adversary.review.v1.schema.json",
    "THIRD_PARTY_NOTICES.md",
    "adversary.yaml",
    "package.json",
  ]) {
    const contents = await readFile(join(projectRoot, path), "utf8");
    assert.doesNotMatch(contents, /\/Users\/[^/]+|\/private\/tmp\/|[A-Z]:\\Users\\/);
  }
});
