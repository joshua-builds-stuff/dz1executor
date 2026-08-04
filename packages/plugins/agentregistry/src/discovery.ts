/**
 * Turning a repository listing into installable candidates.
 *
 * Everything here is pure: it takes a tree listing plus already-fetched manifest
 * bodies and produces candidates and registry manifests. The network lives in
 * `github.ts`, which keeps the interesting rules — what counts as a skill, how a
 * name is derived, what the applied YAML looks like — directly testable.
 */

import type { GitHubCandidate, GitHubSourcedKind } from "./shared";
import type { TreeEntry } from "./github";

/** A skill is any directory containing a SKILL.md. */
const SKILL_MANIFEST = "SKILL.md";
/** Claude-Code-style plugins declare themselves here. */
const PLUGIN_MANIFEST = ".claude-plugin/plugin.json";

/** Directories that never contain first-party sources. */
const IGNORED_SEGMENTS = new Set(["node_modules", ".git", "dist", "build", "vendor", ".venv"]);

const isIgnored = (path: string): boolean =>
  path.split("/").some((segment) => IGNORED_SEGMENTS.has(segment));

const withinSubfolder = (path: string, subfolder?: string): boolean =>
  subfolder === undefined || path === subfolder || path.startsWith(`${subfolder}/`);

/**
 * Registry names are used in URLs and must be stable, so derive a conservative
 * slug and let the operator correct it before applying.
 */
export const toRegistryName = (raw: string): string => {
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/g, "");
  return slug.length > 0 ? slug : "unnamed";
};

/**
 * Minimal reader for the `---`-fenced YAML header at the top of a SKILL.md.
 *
 * Deliberately not a YAML parser: it handles top-level `key: value` scalars,
 * quoted values, and `>`/`|` block scalars, which is the whole of what skill
 * frontmatter uses in practice. Anything more exotic is ignored rather than
 * guessed at, and the caller falls back to directory-derived defaults.
 */
export const parseFrontmatter = (source: string): Record<string, string> => {
  const normalized = source.replace(/^﻿/, "");
  if (!normalized.startsWith("---")) return {};
  const lines = normalized.split("\n");
  const end = lines.findIndex((line, index) => index > 0 && /^---\s*$/.test(line));
  if (end === -1) return {};

  const fields: Record<string, string> = {};
  let key: string | undefined;
  let blockLines: string[] = [];

  const flush = () => {
    if (key === undefined) return;
    fields[key] = blockLines.join(" ").replace(/\s+/g, " ").trim();
    key = undefined;
    blockLines = [];
  };

  for (const line of lines.slice(1, end)) {
    const scalar = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (scalar && !/^\s/.test(line)) {
      flush();
      const [, field, rawValue] = scalar;
      const value = (rawValue ?? "").trim();
      if (value === ">" || value === "|" || value === ">-" || value === "|-") {
        key = field;
        continue;
      }
      fields[field!] = value.replace(/^["']|["']$/g, "");
      continue;
    }
    if (key !== undefined && line.trim().length > 0) blockLines.push(line.trim());
  }
  flush();
  return fields;
};

/** Paths of the manifests that identify installable units, in tree order. */
export const manifestPaths = (
  kind: GitHubSourcedKind,
  listing: readonly TreeEntry[],
  subfolder?: string,
): readonly string[] => {
  const suffix = kind === "skills" ? SKILL_MANIFEST : PLUGIN_MANIFEST;
  return listing
    .filter((entry) => entry.type === "blob")
    .map((entry) => entry.path)
    .filter(
      (path) =>
        (path === suffix || path.endsWith(`/${suffix}`)) &&
        !isIgnored(path) &&
        withinSubfolder(path, subfolder),
    )
    .sort();
};

/** The directory a manifest path installs, or undefined for the repo root. */
export const directoryOf = (manifestPath: string, kind: GitHubSourcedKind): string | undefined => {
  const suffix = kind === "skills" ? SKILL_MANIFEST : PLUGIN_MANIFEST;
  if (manifestPath === suffix) return undefined;
  const directory = manifestPath.slice(0, manifestPath.length - suffix.length - 1);
  return directory.length > 0 ? directory : undefined;
};

const jsonRecord = (source: string): Record<string, unknown> => {
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: plugin.json is arbitrary repository content
  try {
    // oxlint-disable-next-line executor/no-json-parse -- boundary: reading a repository's plugin.json
    const parsed = JSON.parse(source) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

/**
 * Build one candidate from a manifest body. `repoName` and `repoDescription`
 * are the fallbacks used when a root-level manifest carries no name of its own.
 */
export const toCandidate = (input: {
  readonly kind: GitHubSourcedKind;
  readonly manifestPath: string;
  readonly body: string;
  readonly repoName: string;
  readonly repoDescription: string;
}): GitHubCandidate => {
  const subfolder = directoryOf(input.manifestPath, input.kind);
  const directoryName = subfolder?.split("/").pop();

  if (input.kind === "skills") {
    const fields = parseFrontmatter(input.body);
    return {
      name: toRegistryName(fields.name ?? directoryName ?? input.repoName),
      ...(fields.title ? { title: fields.title } : {}),
      description: fields.description ?? input.repoDescription,
      ...(subfolder ? { subfolder } : {}),
      manifestPath: input.manifestPath,
      harnesses: [],
    };
  }

  const manifest = jsonRecord(input.body);
  const declared = Array.isArray(manifest.harnesses)
    ? manifest.harnesses.filter((entry): entry is string => typeof entry === "string")
    : [];
  return {
    name: toRegistryName(text(manifest.name) ?? directoryName ?? input.repoName),
    ...(text(manifest.displayName) ? { title: text(manifest.displayName)! } : {}),
    description: text(manifest.description) ?? input.repoDescription,
    ...(subfolder ? { subfolder } : {}),
    manifestPath: input.manifestPath,
    // A `.claude-plugin/plugin.json` is by construction a Claude Code plugin.
    harnesses: declared.length > 0 ? declared : ["claude-code"],
  };
};

export interface ManifestInput {
  readonly kind: GitHubSourcedKind;
  readonly namespace: string;
  readonly tag: string;
  readonly repositoryUrl: string;
  readonly branch: string;
  readonly commit: string;
  readonly author: string;
  readonly candidate: GitHubCandidate;
}

/**
 * The registry object for one candidate.
 *
 * The commit is pinned rather than tracking the branch: an installed skill must
 * not change under the operator, and the review flow needs a fixed base to diff
 * against. Provenance the registry has no field for (branch, author, manifest
 * path) is kept in annotations so the UI can offer updates later.
 */
export const toManifest = (input: ManifestInput): Record<string, unknown> => {
  const repository = {
    url: input.repositoryUrl,
    branch: input.branch,
    commit: input.commit,
    ...(input.candidate.subfolder ? { subfolder: input.candidate.subfolder } : {}),
  };
  const spec =
    input.kind === "skills"
      ? {
          ...(input.candidate.title ? { title: input.candidate.title } : {}),
          description: input.candidate.description,
          source: { repository },
        }
      : {
          ...(input.candidate.title ? { title: input.candidate.title } : {}),
          description: input.candidate.description,
          harnesses: input.candidate.harnesses,
          source: { type: "git", git: { repository } },
        };
  return {
    apiVersion: "ar.dev/v1alpha1",
    kind: input.kind === "skills" ? "Skill" : "Plugin",
    metadata: {
      name: input.candidate.name,
      namespace: input.namespace,
      tag: input.tag,
      annotations: {
        "executor.dev/source-url": input.repositoryUrl,
        "executor.dev/source-branch": input.branch,
        "executor.dev/source-commit": input.commit,
        "executor.dev/source-author": input.author,
        "executor.dev/source-manifest": input.candidate.manifestPath,
        ...(input.candidate.subfolder
          ? { "executor.dev/source-subfolder": input.candidate.subfolder }
          : {}),
      },
    },
    spec,
  };
};

/** Multi-document JSON stream accepted by `POST /v0/apply`. */
export const toManifestStream = (manifests: readonly Record<string, unknown>[]): string =>
  manifests.map((manifest) => JSON.stringify(manifest, null, 2)).join("\n---\n");
