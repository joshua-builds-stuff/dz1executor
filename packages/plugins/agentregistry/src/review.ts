/**
 * Describing an upstream change in words, and scanning it for risk.
 *
 * A registry that only reports "the commit moved" pushes the whole judgement
 * onto the operator. These functions turn two snapshots of a skill into
 * sentences a person can act on, plus a heuristic scan of what the update *adds*
 * — added lines are what will newly run, so removals are not scanned.
 *
 * The scan is pattern matching, not analysis. It is here to catch the obvious
 * and to force a second look; a clean verdict means "nothing known-bad matched",
 * which is why the UI says "we think" rather than "this is safe".
 */

import { parseFrontmatter } from "./discovery";
import type { SecurityFinding, SecurityReport } from "./shared";

/** One file as it exists at the base and head commits. `null` = absent. */
export interface FileChange {
  readonly path: string;
  readonly base: string | null;
  readonly head: string | null;
}

const lines = (source: string | null): readonly string[] =>
  source === null ? [] : source.replace(/\r\n/g, "\n").split("\n");

/**
 * Lines present in `head` but not `base`, compared as multisets.
 *
 * A positional diff would be more precise about moves, but every consumer here
 * asks the same question — "what text is new?" — for which set difference is
 * both sufficient and immune to reordering noise.
 */
export const addedLines = (change: FileChange): readonly string[] => {
  const before = new Map<string, number>();
  for (const line of lines(change.base)) {
    const key = line.trim();
    if (key.length > 0) before.set(key, (before.get(key) ?? 0) + 1);
  }
  const added: string[] = [];
  for (const line of lines(change.head)) {
    const key = line.trim();
    if (key.length === 0) continue;
    const remaining = before.get(key) ?? 0;
    if (remaining > 0) before.set(key, remaining - 1);
    else added.push(line);
  }
  return added;
};

const removedLineCount = (change: FileChange): number =>
  addedLines({ path: change.path, base: change.head, head: change.base }).length;

const headings = (source: string | null): readonly string[] =>
  lines(source)
    .filter((line) => /^#{1,6}\s+\S/.test(line))
    .map((line) => line.replace(/^#{1,6}\s+/, "").trim());

const quote = (value: string): string =>
  value.length > 80 ? `“${value.slice(0, 77)}…”` : `“${value}”`;

const listSentence = (items: readonly string[]): string =>
  items.length === 1
    ? items[0]!
    : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]!}`;

const FRONTMATTER_LABELS: Record<string, string> = {
  name: "name",
  title: "title",
  description: "description",
  license: "license",
  "allowed-tools": "allowed tools",
  version: "version",
};

/** Plain-language sentences describing what changed between the two snapshots. */
export const summarizeChanges = (
  changes: readonly FileChange[],
  manifestPath: string,
): readonly string[] => {
  const sentences: string[] = [];
  const touched = changes.filter((change) => change.base !== change.head);
  if (touched.length === 0) return ["Nothing changed in the tracked files."];

  const manifest = touched.find((change) => change.path === manifestPath);
  if (manifest) {
    const before = parseFrontmatter(manifest.base ?? "");
    const after = parseFrontmatter(manifest.head ?? "");
    for (const [field, label] of Object.entries(FRONTMATTER_LABELS)) {
      const from = before[field];
      const to = after[field];
      if (from === to) continue;
      if (from === undefined) sentences.push(`The ${label} was set to ${quote(to ?? "")}.`);
      else if (to === undefined) sentences.push(`The ${label} was removed.`);
      else sentences.push(`The ${label} changed from ${quote(from)} to ${quote(to)}.`);
    }

    const beforeHeadings = new Set(headings(manifest.base));
    const afterHeadings = headings(manifest.head);
    const addedSections = afterHeadings.filter((heading) => !beforeHeadings.has(heading));
    const removedSections = [...beforeHeadings].filter(
      (heading) => !afterHeadings.includes(heading),
    );
    if (addedSections.length > 0) {
      sentences.push(
        `New ${addedSections.length === 1 ? "section" : "sections"}: ${listSentence(addedSections.map(quote))}.`,
      );
    }
    if (removedSections.length > 0) {
      sentences.push(
        `Removed ${removedSections.length === 1 ? "section" : "sections"}: ${listSentence(removedSections.map(quote))}.`,
      );
    }
  }

  const created = touched.filter((change) => change.base === null).map((change) => change.path);
  const deleted = touched.filter((change) => change.head === null).map((change) => change.path);
  if (created.length > 0) {
    sentences.push(`Added ${created.length === 1 ? "file" : "files"}: ${listSentence(created)}.`);
  }
  if (deleted.length > 0) {
    sentences.push(`Deleted ${deleted.length === 1 ? "file" : "files"}: ${listSentence(deleted)}.`);
  }

  const added = touched.reduce((total, change) => total + addedLines(change).length, 0);
  const removed = touched.reduce((total, change) => total + removedLineCount(change), 0);
  sentences.push(
    `In total ${added} ${added === 1 ? "line" : "lines"} added and ${removed} ${
      removed === 1 ? "line" : "lines"
    } removed across ${touched.length} ${touched.length === 1 ? "file" : "files"}.`,
  );
  return sentences;
};

interface Rule {
  readonly severity: SecurityFinding["severity"];
  readonly title: string;
  readonly pattern: RegExp;
}

/**
 * Ordered worst-first so the first match on a line is the one reported. Each
 * rule targets a concrete abuse seen in agent instructions, not general
 * "suspicious" wording.
 */
const RULES: readonly Rule[] = [
  {
    severity: "high",
    title: "Pipes a downloaded script straight into a shell",
    pattern: /(curl|wget)[^\n|]*\|\s*(sudo\s+)?(ba|z|d)?sh/i,
  },
  {
    severity: "high",
    title: "Reads credentials or private keys",
    pattern:
      /(~\/\.ssh|id_rsa|\.aws\/credentials|\.netrc|\.npmrc|GITHUB_TOKEN|AWS_SECRET_ACCESS_KEY|ANTHROPIC_API_KEY|OPENAI_API_KEY)/i,
  },
  {
    severity: "high",
    title: "Recursive delete",
    pattern: /\brm\s+-[a-z]*[rf][a-z]*\s+(\/|~|\$HOME|\*)/i,
  },
  {
    severity: "high",
    title: "Decodes and executes obfuscated content",
    pattern: /base64\s+(-d|--decode)[^\n]*\|\s*(ba|z)?sh|eval\s*\(\s*atob\s*\(/i,
  },
  {
    severity: "high",
    title: "Tells the agent to hide activity from the user",
    pattern:
      /(do\s+not|don't|never)\s+(tell|inform|mention|show|report)\s+(the\s+)?(user|human|operator)/i,
  },
  {
    severity: "medium",
    title: "Overrides earlier instructions",
    pattern: /ignore\s+(all\s+)?(previous|prior|earlier|above)\s+(instructions|rules|prompts)/i,
  },
  {
    severity: "medium",
    title: "Instructs the agent to skip confirmation",
    pattern: /(without\s+(asking|confirming|approval)|skip\s+(the\s+)?(confirmation|approval))/i,
  },
  {
    severity: "medium",
    title: "Sends data to an outside host",
    pattern:
      /(curl|wget|fetch|requests\.(post|put))[^\n]*(https?:\/\/(?!github\.com|api\.github\.com|raw\.githubusercontent\.com))/i,
  },
  {
    severity: "medium",
    title: "Runs a privileged command",
    pattern: /\b(sudo|chmod\s+777|chown\s+root)\b/i,
  },
  {
    severity: "low",
    title: "Grants the skill shell access",
    pattern: /^allowed-tools:.*\b(bash|shell|execute)\b/i,
  },
  {
    severity: "low",
    title: "Adds a new executable file",
    pattern: /^\s*#!\s*\/(usr\/bin\/env\s+)?\w+/,
  },
];

const SEVERITY_RANK: Record<SecurityFinding["severity"], number> = { high: 3, medium: 2, low: 1 };

/** Scan the lines an update adds. Findings are deduplicated by title + path. */
export const scanSecurity = (changes: readonly FileChange[]): SecurityReport => {
  const findings: SecurityFinding[] = [];
  const seen = new Set<string>();
  for (const change of changes) {
    for (const line of addedLines(change)) {
      const rule = RULES.find((candidate) => candidate.pattern.test(line));
      if (!rule) continue;
      const key = `${rule.title}::${change.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const trimmed = line.trim();
      findings.push({
        severity: rule.severity,
        title: rule.title,
        evidence: trimmed.length > 200 ? `${trimmed.slice(0, 197)}…` : trimmed,
        path: change.path,
      });
    }
  }
  findings.sort((left, right) => SEVERITY_RANK[right.severity] - SEVERITY_RANK[left.severity]);
  const worst = findings[0]?.severity;
  return {
    verdict: worst === "high" ? "risky" : worst === undefined ? "clean" : "review",
    findings,
  };
};
