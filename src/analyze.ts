import { domain } from "./domain.js";
import { parseGo } from "./parser.js";
import { selectorOracleEvidence, selectorOracleSignals, type SelectorOracleEvidence } from "./selector-oracle.js";
import { type Analysis, type Discovery, type PositiveSignal, type Signal, type SourceRevision } from "./types.js";

export async function analyzeDiscovery(discovery: Discovery): Promise<Analysis> {
  const signals: Signal[] = [];
  const positives: PositiveSignal[] = [];
  const parseErrors: Analysis["parseErrors"] = [];
  const selectorEvidence: SelectorOracleEvidence[] = [];

  for (const file of discovery.files) {
    try {
      if (file.path.endsWith(".go")) {
        const tree = await parseGo(file.current);
        try {
          if (tree.rootNode.hasError) throw new Error("Go source contains syntax errors");
          const result = domain.analyze(file);
          signals.push(...result.signals.filter((item) => changedSignal(file, item)));
          selectorEvidence.push(...selectorOracleEvidence(file, tree));
          positives.push(...result.positives.filter((item) => changed(file, item.line)));
        } finally {
          tree.delete();
        }
        continue;
      }
      const result = domain.analyze(file);
      signals.push(...result.signals.filter((item) => changedSignal(file, item)));
      positives.push(...result.positives.filter((item) => changed(file, item.line)));
    } catch (error) {
      parseErrors.push({ path: file.path, message: error instanceof Error ? error.message : String(error) });
    }
  }

  const files = new Map(discovery.files.map((file) => [file.path, file]));
  signals.push(...selectorOracleSignals(selectorEvidence).filter((signal) => {
    const file = files.get(signal.path);
    return file !== undefined && changedSignal(file, signal);
  }));

  return {
    mode: discovery.mode,
    ...(discovery.base === undefined ? {} : { base: discovery.base }),
    filesScanned: discovery.files.length,
    signals: signals.sort(byLocation),
    positives: positives.sort(byLocation),
    parseErrors: parseErrors.sort((left, right) => left.path.localeCompare(right.path)),
  };
}

function changedSignal(file: SourceRevision, signal: Signal): boolean {
  if (signal.anchors !== undefined) {
    return signal.anchors.some((line) => changed(file, line));
  }
  return changed(file, signal.line, signal.endLine);
}

function changed(file: SourceRevision, line: number, endLine = line): boolean {
  if (file.status === "repository" || file.status === "added") return true;
  for (let candidate = line; candidate <= endLine; candidate += 1) {
    if (file.changedLines.has(candidate)) return true;
  }
  return false;
}

function byLocation(left: { path: string; line: number }, right: { path: string; line: number }): number {
  return left.path.localeCompare(right.path) || left.line - right.line;
}
