/**
 * The GitHub side of quick add: parse what a human pasted, then read the
 * repository through the REST API.
 *
 * Egress is deliberately narrow. Everything goes to `api.github.com` — including
 * file bodies, via the `contents` endpoint with the raw media type — so the
 * plugin needs exactly one host allowed, and a pasted URL can never steer a
 * request at an arbitrary origin.
 */

import { Effect } from "@executor-js/sdk/core";

import { AgentRegistryError } from "./shared";

const GITHUB_API = "https://api.github.com";

/** What a pasted URL resolves to before anything is fetched. */
export interface GitHubTarget {
  readonly owner: string;
  readonly repo: string;
  /** Branch, tag, or commit taken from a `/tree/<ref>/…` style URL. */
  readonly ref?: string;
  /** Repo-relative directory taken from the same URL. */
  readonly subfolder?: string;
}

export type ParseResult =
  | { readonly ok: true; readonly target: GitHubTarget }
  | { readonly ok: false; readonly error: string };

const SEGMENT = /^[A-Za-z0-9._-]+$/;

/**
 * Accepts the shapes people actually paste: a browser URL, a clone URL, a
 * `/tree/` or `/blob/` deep link, or bare `owner/repo`. A `/blob/` link to a
 * manifest resolves to the directory containing it, because that is the unit
 * the registry installs.
 */
export const parseGitHubUrl = (raw: string): ParseResult => {
  const trimmed = raw
    .trim()
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");
  if (trimmed.length === 0) return { ok: false, error: "Enter a GitHub repository URL." };

  const withoutScheme = trimmed
    .replace(/^https?:\/\//i, "")
    .replace(/^git@github\.com:/i, "github.com/")
    .replace(/^www\./i, "");
  // Bare `owner/repo` is recognized by its first segment being a plausible
  // GitHub account — accounts cannot contain a dot, so `example.com/a/b` is a
  // host we do not serve rather than an owner, while `owner/repo.js` still works.
  const bare = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]/.test(withoutScheme);
  const path = withoutScheme.startsWith("github.com/")
    ? withoutScheme.slice("github.com/".length)
    : bare
      ? withoutScheme
      : undefined;
  if (path === undefined) {
    return { ok: false, error: "Only github.com repositories are supported." };
  }

  const segments = path.split("/").filter((segment) => segment.length > 0);
  const [owner, repo, kind, ref, ...rest] = segments;
  if (!owner || !repo) {
    return { ok: false, error: "That URL has no owner/repository. Example: github.com/owner/repo" };
  }
  if (!SEGMENT.test(owner) || !SEGMENT.test(repo)) {
    return { ok: false, error: "Owner and repository may only contain letters, digits, . _ and -" };
  }
  if (kind === undefined) return { ok: true, target: { owner, repo } };
  if (kind !== "tree" && kind !== "blob") {
    return {
      ok: false,
      error: "Link to the repository, or to a directory or file inside it via /tree/ or /blob/.",
    };
  }
  if (!ref || !SEGMENT.test(ref)) {
    return { ok: false, error: "That /tree/ or /blob/ link has no usable branch or commit." };
  }
  // A /blob/ link names a file; the installable unit is its directory.
  const parts = kind === "blob" ? rest.slice(0, -1) : rest;
  if (parts.some((segment) => segment === ".." || segment.length === 0)) {
    return { ok: false, error: "That path is not a valid repository location." };
  }
  return {
    ok: true,
    target: { owner, repo, ref, subfolder: parts.length > 0 ? parts.join("/") : undefined },
  };
};

/** Canonical clone URL stored in the manifest, regardless of what was pasted. */
export const repositoryUrl = (target: Pick<GitHubTarget, "owner" | "repo">): string =>
  `https://github.com/${target.owner}/${target.repo}`;

export interface GitHubClientOptions {
  /** Optional PAT. Raises the anonymous 60 req/hr limit and reaches private repos. */
  readonly token?: string;
  /** Overridable for tests; must remain a full origin. */
  readonly apiBaseUrl?: string;
}

export interface TreeEntry {
  readonly path: string;
  readonly type: string;
}

export interface RepoInfo {
  readonly defaultBranch: string;
  readonly description: string;
}

export interface CommitInfo {
  readonly sha: string;
  readonly author: string;
  readonly authoredAt: string;
  readonly subject: string;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

const stringField = (source: Record<string, unknown>, key: string): string | undefined => {
  const value = source[key];
  return typeof value === "string" ? value : undefined;
};

/**
 * A single request against the GitHub REST API. `accept` switches between the
 * JSON API and raw file bodies; the caller decodes accordingly.
 */
const githubRequest = (
  options: GitHubClientOptions,
  path: string,
  accept: string,
): Effect.Effect<string, AgentRegistryError> =>
  Effect.tryPromise({
    try: async () => {
      const headers = new Headers({ Accept: accept, "X-GitHub-Api-Version": "2022-11-28" });
      if (options.token) headers.set("Authorization", `Bearer ${options.token}`);
      const response = await fetch(new URL(path, `${options.apiBaseUrl ?? GITHUB_API}/`), {
        headers,
        redirect: "error",
      });
      const body = await response.text();
      if (!response.ok) {
        const remaining = response.headers.get("x-ratelimit-remaining");
        const hint =
          response.status === 403 && remaining === "0"
            ? " GitHub's anonymous rate limit is exhausted — set GITHUB_TOKEN on the Executor server."
            : response.status === 404
              ? " Check the URL, and note that private repositories need GITHUB_TOKEN."
              : "";
        // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: normalized into AgentRegistryError by the surrounding tryPromise
        throw new Error(`GitHub returned ${response.status}.${hint}`);
      }
      return body;
    },
    catch: (cause) => new AgentRegistryError({ message: String(cause || "GitHub request failed") }),
  });

const githubJson = (
  options: GitHubClientOptions,
  path: string,
): Effect.Effect<unknown, AgentRegistryError> =>
  githubRequest(options, path, "application/vnd.github+json").pipe(
    Effect.flatMap((body) =>
      Effect.try({
        // oxlint-disable-next-line executor/no-json-parse -- boundary: decoding GitHub's HTTP response
        try: () => JSON.parse(body) as unknown,
        catch: () => new AgentRegistryError({ message: "GitHub returned a malformed response." }),
      }),
    ),
  );

export const fetchRepo = (
  options: GitHubClientOptions,
  target: GitHubTarget,
): Effect.Effect<RepoInfo, AgentRegistryError> =>
  githubJson(options, `repos/${target.owner}/${target.repo}`).pipe(
    Effect.map((payload) => {
      const record = asRecord(payload);
      return {
        defaultBranch: stringField(record, "default_branch") ?? "main",
        description: stringField(record, "description") ?? "",
      };
    }),
  );

/**
 * Latest commit touching `subfolder` on `ref`. Scoping to the subfolder matters
 * for monorepos: a skill in `skills/foo` should not look updated because an
 * unrelated directory moved.
 */
export const fetchLatestCommit = (
  options: GitHubClientOptions,
  target: GitHubTarget,
  ref: string,
  subfolder?: string,
): Effect.Effect<CommitInfo, AgentRegistryError> => {
  const query = new URLSearchParams({ sha: ref, per_page: "1" });
  if (subfolder) query.set("path", subfolder);
  return githubJson(options, `repos/${target.owner}/${target.repo}/commits?${query}`).pipe(
    Effect.flatMap((payload) => {
      const first = Array.isArray(payload) ? asRecord(payload[0]) : {};
      const sha = stringField(first, "sha");
      if (!sha) {
        return Effect.fail(
          new AgentRegistryError({
            message: subfolder
              ? `No commits found for ${subfolder} on ${ref}.`
              : `No commits found on ${ref}.`,
          }),
        );
      }
      const commit = asRecord(first.commit);
      const commitAuthor = asRecord(commit.author);
      const account = asRecord(first.author);
      const message = stringField(commit, "message") ?? "";
      return Effect.succeed({
        sha,
        author:
          stringField(account, "login") ?? stringField(commitAuthor, "name") ?? "unknown author",
        authoredAt: stringField(commitAuthor, "date") ?? "",
        subject: message.split("\n")[0] ?? "",
      });
    }),
  );
};

export interface TreeListing {
  readonly entries: readonly TreeEntry[];
  /** GitHub caps very large trees; the caller surfaces this to the user. */
  readonly truncated: boolean;
}

export const fetchTree = (
  options: GitHubClientOptions,
  target: GitHubTarget,
  commit: string,
): Effect.Effect<TreeListing, AgentRegistryError> =>
  githubJson(options, `repos/${target.owner}/${target.repo}/git/trees/${commit}?recursive=1`).pipe(
    Effect.map((payload) => {
      const record = asRecord(payload);
      const tree = Array.isArray(record.tree) ? record.tree : [];
      return {
        entries: tree.flatMap((entry): TreeEntry[] => {
          const item = asRecord(entry);
          const path = stringField(item, "path");
          return path ? [{ path, type: stringField(item, "type") ?? "blob" }] : [];
        }),
        truncated: record.truncated === true,
      };
    }),
  );

export interface ComparedFile {
  readonly path: string;
  /** GitHub's status: added, removed, modified, renamed, … */
  readonly status: string;
}

/**
 * Which files differ between two commits.
 *
 * One request replaces a per-file walk of both trees: a skill directory with
 * thirty files but a one-file update costs a single call here, instead of sixty
 * content fetches to discover that twenty-nine of them are identical.
 */
export const fetchComparison = (
  options: GitHubClientOptions,
  target: GitHubTarget,
  base: string,
  head: string,
): Effect.Effect<readonly ComparedFile[], AgentRegistryError> =>
  githubJson(
    options,
    `repos/${target.owner}/${target.repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
  ).pipe(
    Effect.map((payload) => {
      const files = asRecord(payload).files;
      return Array.isArray(files)
        ? files.flatMap((entry): ComparedFile[] => {
            const item = asRecord(entry);
            const path = stringField(item, "filename");
            return path ? [{ path, status: stringField(item, "status") ?? "modified" }] : [];
          })
        : [];
    }),
  );

/** File body at an exact commit. `null` when the file does not exist there. */
export const fetchFile = (
  options: GitHubClientOptions,
  target: GitHubTarget,
  commit: string,
  path: string,
): Effect.Effect<string | null, AgentRegistryError> =>
  githubRequest(
    options,
    `repos/${target.owner}/${target.repo}/contents/${path
      .split("/")
      .map(encodeURIComponent)
      .join("/")}?ref=${encodeURIComponent(commit)}`,
    "application/vnd.github.raw",
  ).pipe(
    Effect.catchTag("AgentRegistryError", (error) =>
      error.message.includes("404") ? Effect.succeed(null) : Effect.fail(error),
    ),
  );
