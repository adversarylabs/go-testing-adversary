import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RuleContext } from "@adversarylabs/sdk";
import { domain } from "./domain.js";
import { type Discovery, type SourceRevision } from "./types.js";

const MAX_FILE_BYTES = 750_000;
const MAX_FILES = 750;
const execute = promisify(execFile);

/**
 * Load Go sources for the runner's review scope.
 *
 * Scope ownership lives in the CLI/SDK (`change.changedFiles` includes untracked
 * worktree paths; `--all-files` walks the target). Git is used only to classify
 * those already-scoped paths and recover their changed line ranges.
 */
export async function discoverSources(ctx: RuleContext): Promise<Discovery> {
  const sources = await ctx.loadInScopeSources({
    include: domain.includePath,
    limit: MAX_FILES,
    maxBytes: MAX_FILE_BYTES,
  });

  const wholeTarget = ctx.change === null || ctx.change.scanMode === "all";
  const files: SourceRevision[] = [];
  for (const source of sources) {
    if (source.status === "repository") {
      files.push({
        path: source.path,
        current: source.content,
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
      changedLines: change.changedLines,
      deletedHunks: change.deletedHunks,
      status: change.status,
    });
  }

  return {
    mode: wholeTarget ? "repository" : "diff",
    ...(ctx.change?.baseRef === undefined ? {} : { base: ctx.change.baseRef }),
    files,
  };
}

async function changedSource(
  ctx: RuleContext,
  path: string,
): Promise<{
  changedLines: Set<number>;
  deletedHunks: NonNullable<SourceRevision["deletedHunks"]>;
  status: SourceRevision["status"];
}> {
  const base = ctx.change?.baseRef;
  if (base === undefined || !(await existsAtRevision(ctx.repoPath, base, path))) {
    return { changedLines: new Set<number>(), deletedHunks: [], status: "added" };
  }

  const args = ["diff", "--unified=0", base];
  const head = ctx.change?.headRef;
  if (head !== undefined && !ctx.change?.worktree) args.push(head);
  args.push("--", path);
  const patch = await gitOutput(ctx.repoPath, args);
  return { ...changeProvenance(patch), status: "modified" };
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
