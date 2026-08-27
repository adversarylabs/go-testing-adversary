import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import type { RuleContext } from "@adversarylabs/sdk";
import { domain } from "./domain.js";
import { type Discovery, type SourceRevision } from "./types.js";

const MAX_FILE_BYTES = 750_000;
const MAX_FILES = 750;
const MAX_CONTEXT_FILES = 150;
const execute = promisify(execFile);

/**
 * Load Go sources for the runner's review scope.
 *
 * Scope ownership lives in the CLI/SDK (`change.changedFiles` includes untracked
 * worktree paths; `--all-files` walks the target). Git is used only to classify
 * those already-scoped paths and recover their changed line ranges.
 */
export async function discoverSources(ctx: RuleContext): Promise<Discovery> {
  const wholeTarget = ctx.change === null || ctx.change.scanMode === "all";
  const changedTestDirectories = wholeTarget
    ? new Set<string>()
    : new Set(
      (ctx.change?.changedFiles ?? [])
        .map(normalizeRepoPath)
        .filter(domain.includePath)
        .map((path) => dirname(path).replaceAll("\\", "/")),
    );
  const sources = await ctx.loadInScopeSources({
    include: (path) => {
      const normalized = normalizeRepoPath(path);
      if (domain.includePath(normalized)) return true;
      return !wholeTarget && normalized.endsWith(".go") &&
        changedTestDirectories.has(dirname(normalized).replaceAll("\\", "/"));
    },
    limit: MAX_FILES,
    maxBytes: MAX_FILE_BYTES,
  });

  const files: SourceRevision[] = [];
  for (const source of sources) {
    const contextOnly = !domain.includePath(source.path);
    if (source.status === "repository") {
      files.push({
        path: source.path,
        current: source.content,
        ...(contextOnly ? { contextOnly: true } : {}),
        changedLines: new Set<number>(),
        deletedHunks: [],
        status: "repository",
      });
      continue;
    }

    const change = await changedSource(ctx, source.path);
    files.push({
      path: source.path,
      current: source.content,
      ...(contextOnly ? { contextOnly: true } : {}),
      ...(change.previous === undefined ? {} : { previous: change.previous }),
      changedLines: change.changedLines,
      deletedHunks: change.deletedHunks,
      status: change.status,
    });
  }

  if (!wholeTarget && files.length < MAX_FILES) {
    files.push(...await siblingTestContext(
      ctx.repoPath,
      changedTestDirectories,
      new Set(files.map((file) => normalizeRepoPath(file.path))),
      Math.min(MAX_CONTEXT_FILES, MAX_FILES - files.length),
    ));
  }
  files.sort((left, right) => left.path.localeCompare(right.path));

  return {
    mode: wholeTarget ? "repository" : "diff",
    ...(ctx.change?.baseRef === undefined ? {} : { base: ctx.change.baseRef }),
    files,
  };
}

/**
 * Load only unchanged direct sibling tests for packages whose tests changed.
 * They can close a cross-method coverage gap, but they never count as changed
 * files, ordinary findings, parse errors, or files scanned.
 */
async function siblingTestContext(
  repository: string,
  directories: Set<string>,
  knownPaths: Set<string>,
  limit: number,
): Promise<SourceRevision[]> {
  if (limit <= 0) return [];
  let root: string;
  try {
    root = await realpath(repository);
  } catch {
    return [];
  }

  const context: SourceRevision[] = [];
  for (const directory of [...directories].sort()) {
    if (context.length >= limit) break;
    const absoluteDirectory = await safeExistingPath(root, join(root, ...directory.split("/")));
    if (absoluteDirectory === undefined) continue;
    let entries: Dirent[];
    try {
      entries = await readdir(absoluteDirectory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (context.length >= limit || !entry.isFile() || !entry.name.endsWith("_test.go")) continue;
      const path = normalizeRepoPath(directory === "." ? entry.name : `${directory}/${entry.name}`);
      if (knownPaths.has(path)) continue;
      try {
        const absolute = await safeExistingPath(root, join(absoluteDirectory, entry.name));
        if (absolute === undefined) continue;
        const metadata = await stat(absolute);
        if (!metadata.isFile() || metadata.size > MAX_FILE_BYTES) continue;
        const current = await readFile(absolute, "utf8");
        if (Buffer.byteLength(current, "utf8") > MAX_FILE_BYTES || current.includes("\0")) continue;
        context.push({
          path,
          current,
          contextOnly: true,
          changedLines: new Set<number>(),
          deletedHunks: [],
          status: "context",
        });
        knownPaths.add(path);
      } catch {
        // Unreadable or disappearing context is not reliable evidence.
      }
    }
  }
  return context;
}

function normalizeRepoPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

async function safeExistingPath(root: string, path: string): Promise<string | undefined> {
  try {
    const candidate = await realpath(path);
    const fromRoot = relative(root, candidate);
    if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) return undefined;
    return candidate;
  } catch {
    return undefined;
  }
}

async function changedSource(
  ctx: RuleContext,
  path: string,
): Promise<{
  previous?: string;
  changedLines: Set<number>;
  deletedHunks: NonNullable<SourceRevision["deletedHunks"]>;
  status: SourceRevision["status"];
}> {
  const base = ctx.change?.baseRef;
  if (base === undefined || !(await existsAtRevision(ctx.repoPath, base, path))) {
    return { changedLines: new Set<number>(), deletedHunks: [], status: "added" };
  }

  const previous = await gitOutput(ctx.repoPath, ["show", `${base}:${path}`]);

  const args = ["diff", "--unified=0", base];
  const head = ctx.change?.headRef;
  if (head !== undefined && !ctx.change?.worktree) args.push(head);
  args.push("--", path);
  const patch = await gitOutput(ctx.repoPath, args);
  return { ...changeProvenance(patch), previous, status: "modified" };
}

async function existsAtRevision(repoPath: string, revision: string, path: string): Promise<boolean> {
  try {
    await execute("git", ["-C", repoPath, "cat-file", "-e", `${revision}:${path}`], {
      maxBuffer: 1024 * 1024,
    });
    return true;
  } catch {
    return false;
  }
}

async function gitOutput(repoPath: string, args: string[]): Promise<string> {
  const result = await execute("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  return result.stdout;
}

function changeProvenance(
  patch: string,
): {
  changedLines: Set<number>;
  deletedHunks: NonNullable<SourceRevision["deletedHunks"]>;
} {
  const changedLines = new Set<number>();
  const deletedHunks: NonNullable<SourceRevision["deletedHunks"]> = [];
  for (const match of patch.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    const oldCount = match[2] === undefined ? 1 : Number(match[2]);
    const start = Number(match[3]);
    const count = match[4] === undefined ? 1 : Number(match[4]);
    if (count === 0 && oldCount > 0) {
      deletedHunks.push({ afterLine: start, deletedLines: oldCount });
      continue;
    }
    for (let line = start; line < start + count; line += 1) changedLines.add(line);
  }
  return { changedLines, deletedHunks };
}
