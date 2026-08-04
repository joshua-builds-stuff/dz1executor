import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";

export const AgentRegistryMethod = Schema.Literals(["GET", "POST", "PUT", "PATCH", "DELETE"]);

export const AgentRegistryRequest = Schema.Struct({
  method: AgentRegistryMethod,
  path: Schema.String,
  query: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  body: Schema.optional(Schema.String),
  contentType: Schema.optional(Schema.String),
});
export type AgentRegistryRequest = typeof AgentRegistryRequest.Type;

export const AgentRegistryResponse = Schema.Struct({
  ok: Schema.Boolean,
  status: Schema.Number,
  contentType: Schema.String,
  body: Schema.String,
});
export type AgentRegistryResponse = typeof AgentRegistryResponse.Type;

export const AgentRegistryConfig = Schema.Struct({
  baseUrl: Schema.String,
  configured: Schema.Boolean,
  authenticated: Schema.Boolean,
  resourceKinds: Schema.Array(Schema.String),
});

export class AgentRegistryError extends Schema.TaggedErrorClass<AgentRegistryError>()(
  "AgentRegistryError",
  {
    message: Schema.String,
    status: Schema.optional(Schema.Number),
  },
  { httpApiStatus: 502 },
) {}

// --- GitHub quick add --------------------------------------------------------
//
// Skills and Plugins are both git-sourced: their spec is a pointer to a
// repository, not an inline body. Authoring that pointer by hand means knowing
// the default branch, the subfolder, and the exact resource name — all of which
// are already discoverable from the repository itself. These contracts let the
// UI take a pasted GitHub URL and resolve it into ready-to-apply manifests.

/** Kinds whose spec is a git source, and so support GitHub quick add. */
export const GITHUB_SOURCED_KINDS = ["skills", "plugins"] as const;
export const GitHubSourcedKind = Schema.Literals(GITHUB_SOURCED_KINDS);
export type GitHubSourcedKind = (typeof GITHUB_SOURCED_KINDS)[number];

/** One installable unit found inside a repository. */
export const GitHubCandidate = Schema.Struct({
  /** Registry-safe suggested `metadata.name`. Editable before apply. */
  name: Schema.String,
  /** Human title from the manifest frontmatter, when the source provides one. */
  title: Schema.optional(Schema.String),
  description: Schema.String,
  /** Repo-relative directory holding the skill/plugin. Absent means repo root. */
  subfolder: Schema.optional(Schema.String),
  /** Repo-relative path of the manifest that identified this candidate. */
  manifestPath: Schema.String,
  /** Harnesses declared by a plugin manifest; empty for skills. */
  harnesses: Schema.Array(Schema.String),
});
export type GitHubCandidate = typeof GitHubCandidate.Type;

export const GitHubDiscoverRequest = Schema.Struct({
  url: Schema.String,
  kind: GitHubSourcedKind,
});
export type GitHubDiscoverRequest = typeof GitHubDiscoverRequest.Type;

export const GitHubDiscoverResponse = Schema.Struct({
  /** Canonical `https://github.com/owner/repo` clone URL for the manifest. */
  repositoryUrl: Schema.String,
  owner: Schema.String,
  repo: Schema.String,
  /** Branch the candidates were read from. */
  branch: Schema.String,
  /** Commit the branch pointed at during discovery. */
  commit: Schema.String,
  /** Display name of whoever authored that commit. */
  author: Schema.String,
  candidates: Schema.Array(GitHubCandidate),
  /** Non-fatal notes, e.g. a truncated tree listing on a very large repo. */
  warnings: Schema.Array(Schema.String),
});
export type GitHubDiscoverResponse = typeof GitHubDiscoverResponse.Type;

// --- Update review -----------------------------------------------------------
//
// A registered skill pins a commit. When upstream moves, the only thing the
// registry can say is "the sha changed" — which is not enough to decide whether
// to take the update. These contracts carry a plain-language description of the
// change plus a heuristic risk scan of the added lines.

export const SecurityFinding = Schema.Struct({
  severity: Schema.Literals(["high", "medium", "low"]),
  /** Short category label, e.g. "Pipes a downloaded script into a shell". */
  title: Schema.String,
  /** The added line that triggered the finding, trimmed for display. */
  evidence: Schema.String,
  /** Repo-relative file the evidence came from. */
  path: Schema.String,
});
export type SecurityFinding = typeof SecurityFinding.Type;

export const SecurityReport = Schema.Struct({
  /** `clean` = no heuristic matched; `review`/`risky` follow the worst finding. */
  verdict: Schema.Literals(["clean", "review", "risky"]),
  findings: Schema.Array(SecurityFinding),
});
export type SecurityReport = typeof SecurityReport.Type;

export const ReviewRequest = Schema.Struct({
  url: Schema.String,
  subfolder: Schema.optional(Schema.String),
  /** Branch to compare against. Defaults to the repository default branch. */
  branch: Schema.optional(Schema.String),
  /** Currently pinned commit. Absent means "describe the current content". */
  baseCommit: Schema.optional(Schema.String),
  /**
   * Repo-relative path of the source's own manifest, used to describe
   * frontmatter and section changes. Defaults to the skill layout.
   */
  manifestPath: Schema.optional(Schema.String),
});
export type ReviewRequest = typeof ReviewRequest.Type;

export const ReviewResponse = Schema.Struct({
  repositoryUrl: Schema.String,
  branch: Schema.String,
  baseCommit: Schema.optional(Schema.String),
  headCommit: Schema.String,
  /** Author of the head commit. */
  author: Schema.String,
  /** ISO timestamp of the head commit. */
  authoredAt: Schema.String,
  commitSubject: Schema.String,
  /** True when the pinned commit already matches upstream. */
  upToDate: Schema.Boolean,
  /** Plain-language sentences describing what changed. */
  changes: Schema.Array(Schema.String),
  security: SecurityReport,
});
export type ReviewResponse = typeof ReviewResponse.Type;

export const AgentRegistryApi = HttpApiGroup.make("agentregistry")
  .add(
    HttpApiEndpoint.post("config", "/agentregistry/config", {
      success: AgentRegistryConfig,
      error: AgentRegistryError,
    }),
  )
  .add(
    HttpApiEndpoint.post("request", "/agentregistry/request", {
      payload: AgentRegistryRequest,
      success: AgentRegistryResponse,
      error: AgentRegistryError,
    }),
  )
  .add(
    HttpApiEndpoint.post("discover", "/agentregistry/github/discover", {
      payload: GitHubDiscoverRequest,
      success: GitHubDiscoverResponse,
      error: AgentRegistryError,
    }),
  )
  .add(
    HttpApiEndpoint.post("review", "/agentregistry/github/review", {
      payload: ReviewRequest,
      success: ReviewResponse,
      error: AgentRegistryError,
    }),
  );

export const AGENTREGISTRY_RESOURCE_KINDS = [
  "agents",
  "mcpservers",
  "skills",
  "prompts",
  "models",
  "plugins",
  "runtimes",
  "deployments",
] as const;
