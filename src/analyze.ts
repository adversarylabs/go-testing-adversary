import { domain } from "./domain.js";
import { parseGo } from "./parser.js";
import { partitionOracleSignals } from "./partition-oracle.js";
import { privilegedHostPathSignals } from "./privileged-host-path.js";
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
          signals.push(...result.signals.flatMap((item) => localizeSignal(file, item)));
          const privileged = privilegedHostPathSignals(file, tree);
          const partitionOracle = partitionOracleSignals(file, tree);
          if (file.status === "modified" && file.previous !== undefined) {
            const previousTree = await parseGo(file.previous);
            try {
              const previousFile = { ...file, current: file.previous, status: "repository" as const };
              signals.push(...novelSemanticSignals(
                file,
                privileged,
                privilegedHostPathSignals(previousFile, previousTree),
              ));
              signals.push(...novelSemanticSignals(
                file,
                partitionOracle,
                partitionOracleSignals(previousFile, previousTree),
              ));
            } finally {
              previousTree.delete();
            }
          } else {
            signals.push(...privileged.flatMap((item) => localizeSignal(file, item)));
            signals.push(...partitionOracle.flatMap((item) => localizeSignal(file, item)));
          }
          selectorEvidence.push(...selectorOracleEvidence(file, tree));
          positives.push(...result.positives.filter((item) => changed(file, item.line)));
        } finally {
          tree.delete();
        }
        continue;
      }
      const result = domain.analyze(file);
      signals.push(...result.signals.flatMap((item) => localizeSignal(file, item)));
      positives.push(...result.positives.filter((item) => changed(file, item.line)));
    } catch (error) {
      parseErrors.push({ path: file.path, message: error instanceof Error ? error.message : String(error) });
    }
  }

  const files = new Map(discovery.files.map((file) => [file.path, file]));
  signals.push(...selectorOracleSignals(selectorEvidence).flatMap((signal) => {
    const file = files.get(signal.path);
    return file === undefined ? [] : localizeSignal(file, signal);
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

function novelSemanticSignals(file: SourceRevision, current: Signal[], previous: Signal[]): Signal[] {
  const previousFingerprints = occurrenceCounts(previous.map((signal) => String(signal.data.fingerprint ?? "")));
  return current.flatMap((signal) => {
    const fingerprint = String(signal.data.fingerprint ?? "");
    const count = previousFingerprints.get(fingerprint) ?? 0;
    if (count > 0) {
      previousFingerprints.set(fingerprint, count - 1);
      return [];
    }
    return localizeSignal(file, signal);
  });
}

function occurrenceCounts(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

export function localizeSignal(file: SourceRevision, signal: Signal): Signal[] {
  if (file.status === "repository" || file.status === "added") return [signal];
  if (signal.locality === undefined) return [];

  const locality = signal.locality;
  const candidates = locality.kind === "direct"
    ? locality.anchors
    : [...file.changedLines].filter(
      (line) => line >= locality.startLine && line <= locality.endLine,
    );
  const changedLine = [...new Set(candidates)]
    .filter((line) => file.changedLines.has(line))
    .sort((left, right) => left - right)[0];
  if (changedLine === undefined) {
    if (locality.kind !== "scope") return [];
    const deletion = (file.deletedHunks ?? []).find(
      (hunk) => hunk.afterLine >= locality.startLine && hunk.afterLine < locality.endLine,
    );
    if (deletion === undefined) return [];

    return [localizedSignal(file, signal, locality.startLine, {
      ...signal.data,
      localityChange: { kind: "deletion", ...deletion },
    })];
  }

  return [localizedSignal(file, signal, changedLine, signal.data)];
}

function localizedSignal(
  file: SourceRevision,
  signal: Signal,
  line: number,
  data: Signal["data"],
): Signal {
  const { endLine: _endLine, ...localized } = signal;
  return {
    ...localized,
    line,
    snippet: (file.current.split("\n")[line - 1] ?? "").trim().slice(0, 300),
    data,
  };
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
