import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("the build fails closed on stale as well as missing license mappings", async () => {
  const source = await readFile(new URL("../scripts/build.mjs", import.meta.url), "utf8");
  assert.match(source, /missing full license text mapping for bundled package/);
  assert.match(source, /stale license mapping for unbundled package/);

  const scratch = await mkdtemp(join(tmpdir(), "go-testing-license-inventory-"));
  const instrumented = source
    .replace('import { build } from "esbuild";\n', "")
    .replace('await rm("dist", { recursive: true, force: true });', "")
    .replace(/const result = await build\([\s\S]*?\n\}\);/, 'const result = { metafile: { inputs: { "node_modules/fast-uri/index.js": {} } } };')
    .replace(/await copyFile\([\s\S]*?\n\);/g, "")
    .replace(/await mkdir\([\s\S]*?\n\);/g, "")
    .replace(/await writeFile\([\s\S]*?\n\);/g, "")
    .replace(/const licenseCatalog = new Map\(\[[\s\S]*?\n\]\);/, `const licenseCatalog = new Map([
  ["fast-uri", ["BSD-3-Clause", "unused"]],
  ["stale-package", ["MIT", "unused"]],
]);`);
  const path = join(scratch, "probe.mjs");
  await writeFile(path, instrumented);

  await assert.rejects(import(path), /stale license mapping for unbundled package\(s\): stale-package/);
});
