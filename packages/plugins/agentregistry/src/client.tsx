/* oxlint-disable react/forbid-elements -- standalone plugin UI follows the public plugin SDK convention */
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { createPluginAtomClient, defineClientPlugin, useAtomSet } from "@executor-js/sdk/client";

import {
  AGENTREGISTRY_RESOURCE_KINDS,
  GITHUB_SOURCED_KINDS,
  AgentRegistryApi,
  type AgentRegistryRequest,
  type AgentRegistryResponse,
  type GitHubCandidate,
  type GitHubDiscoverResponse,
  type GitHubSourcedKind,
  type ReviewResponse,
  type SecurityFinding,
} from "./shared";
import { toManifest, toManifestStream, toRegistryName } from "./discovery";

const AgentRegistryClient = createPluginAtomClient(AgentRegistryApi);
const configMutation = AgentRegistryClient.mutation("agentregistry", "config");
const requestMutation = AgentRegistryClient.mutation("agentregistry", "request");
const discoverMutation = AgentRegistryClient.mutation("agentregistry", "discover");
const reviewMutation = AgentRegistryClient.mutation("agentregistry", "review");

type ResourceKind = (typeof AGENTREGISTRY_RESOURCE_KINDS)[number];
type RegistryObject = {
  readonly apiVersion?: string;
  readonly kind?: string;
  readonly metadata?: {
    readonly namespace?: string;
    readonly name?: string;
    readonly tag?: string;
    readonly labels?: Readonly<Record<string, string>>;
    readonly annotations?: Readonly<Record<string, string>>;
    readonly updatedAt?: string;
    readonly deletionTimestamp?: string;
  };
  readonly spec?: unknown;
  readonly status?: unknown;
};

const labels: Record<ResourceKind, string> = {
  agents: "Agents",
  mcpservers: "MCP Servers",
  skills: "Skills",
  prompts: "Prompts",
  models: "Models",
  plugins: "Plugins",
  runtimes: "Runtimes",
  deployments: "Deployments",
};

const singularKind: Record<ResourceKind, string> = {
  agents: "Agent",
  mcpservers: "MCPServer",
  skills: "Skill",
  prompts: "Prompt",
  models: "Model",
  plugins: "Plugin",
  runtimes: "Runtime",
  deployments: "Deployment",
};

const defaultSpecs: Record<ResourceKind, unknown> = {
  agents: { description: "", mode: "harness", harnesses: ["codex"], mcpServers: [], skills: [] },
  mcpservers: {
    description: "",
    packages: [{ registryType: "npm", identifier: "@example/mcp-server", version: "latest" }],
  },
  skills: { description: "", source: { repository: { url: "https://github.com/example/skill" } } },
  prompts: { description: "", content: "" },
  models: { provider: "bedrock", model: "us.anthropic.claude-opus-4-8" },
  plugins: {
    description: "",
    harnesses: ["codex"],
    source: { type: "git", git: { repository: { url: "https://github.com/example/plugin" } } },
  },
  runtimes: { type: "Local", config: {} },
  deployments: {
    targetRef: { kind: "MCPServer", name: "example", tag: "latest" },
    runtimeRef: { name: "local" },
    desiredState: "deployed",
  },
};

const manifestTemplate = (kind: ResourceKind): string =>
  JSON.stringify(
    {
      apiVersion: "ar.dev/v1alpha1",
      kind: singularKind[kind],
      metadata: {
        name: `new-${singularKind[kind].toLowerCase()}`,
        ...(kind === "runtimes" || kind === "deployments" ? {} : { tag: "latest" }),
      },
      spec: defaultSpecs[kind],
    },
    null,
    2,
  );

const parseBody = (response: AgentRegistryResponse): unknown => {
  if (!response.body) return null;
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: best-effort rendering of an arbitrary upstream HTTP response
  try {
    // oxlint-disable-next-line executor/no-json-parse -- boundary: AgentRegistry can return JSON, YAML, metrics, or plain text
    return JSON.parse(response.body);
  } catch {
    return response.body;
  }
};

const extractItems = (payload: unknown, kind: ResourceKind): RegistryObject[] => {
  if (Array.isArray(payload)) return payload as RegistryObject[];
  if (!payload || typeof payload !== "object") return [];
  const record = payload as Record<string, unknown>;
  const candidate = record.items ?? record[kind];
  return Array.isArray(candidate) ? (candidate as RegistryObject[]) : [];
};

const extractNextCursor = (payload: unknown): string | undefined => {
  if (!payload || typeof payload !== "object") return undefined;
  const record = payload as Record<string, unknown>;
  const direct = record.nextCursor;
  if (typeof direct === "string" && direct.length > 0) return direct;
  const metadata = record.metadata;
  if (metadata && typeof metadata === "object") {
    const nested = (metadata as Record<string, unknown>).nextCursor;
    if (typeof nested === "string" && nested.length > 0) return nested;
  }
  return undefined;
};

const applyFailure = (response: AgentRegistryResponse): string | undefined => {
  const payload = parseBody(response);
  if (!payload || typeof payload !== "object") return undefined;
  const results = (payload as Record<string, unknown>).results;
  if (!Array.isArray(results)) return undefined;
  const failed = results.filter(
    (result) =>
      result &&
      typeof result === "object" &&
      (result as Record<string, unknown>).status === "failed",
  );
  if (failed.length === 0) return undefined;
  return failed
    .map((result) => String((result as Record<string, unknown>).error ?? "apply failed"))
    .join("\n");
};

const formatError = (cause: unknown): string => String(cause || "AgentRegistry request failed");

const pageStyle: CSSProperties = { height: "100%", overflowY: "auto" };

// --- Reading a registry object ----------------------------------------------
//
// Skills and Plugins nest their git source differently, and the controller may
// or may not have resolved a commit yet. These readers collapse that into the
// few facts the catalog and the update review need, so the JSX stays flat.

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

const stringOf = (source: Record<string, unknown>, key: string): string | undefined => {
  const value = source[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

const isGitHubSourced = (kind: ResourceKind): kind is GitHubSourcedKind =>
  (GITHUB_SOURCED_KINDS as readonly string[]).includes(kind);

interface SourceInfo {
  readonly url?: string;
  readonly branch?: string;
  readonly commit?: string;
  readonly subfolder?: string;
  readonly author?: string;
  readonly manifestPath?: string;
}

/**
 * Where a resource came from. `spec` is authoritative; the annotations written
 * at quick-add time fill in what the registry has no field for (branch, author),
 * and `status.resolvedSource` wins on commit because it is what the controller
 * actually checked out.
 */
const sourceOf = (item: RegistryObject): SourceInfo => {
  const spec = record(item.spec);
  const source = record(spec.source);
  const repository = record(record(source.git).repository ?? source.repository);
  const annotations = record(item.metadata?.annotations);
  const resolved = record(record(item.status).resolvedSource);
  return {
    url: stringOf(repository, "url") ?? stringOf(annotations, "executor.dev/source-url"),
    branch: stringOf(repository, "branch") ?? stringOf(annotations, "executor.dev/source-branch"),
    commit:
      stringOf(resolved, "commit") ??
      stringOf(repository, "commit") ??
      stringOf(annotations, "executor.dev/source-commit"),
    subfolder:
      stringOf(repository, "subfolder") ?? stringOf(annotations, "executor.dev/source-subfolder"),
    author: stringOf(annotations, "executor.dev/source-author"),
    manifestPath: stringOf(annotations, "executor.dev/source-manifest"),
  };
};

const describe = (item: RegistryObject): string | undefined =>
  stringOf(record(item.spec), "description");

const titleOf = (item: RegistryObject): string | undefined => stringOf(record(item.spec), "title");

const shortCommit = (commit?: string): string | undefined => commit?.slice(0, 7);

interface Condition {
  readonly type: string;
  readonly status: string;
  readonly reason?: string;
  readonly message?: string;
}

/**
 * The controller's own verdict on a resource.
 *
 * This is the first thing an operator needs: a Skill whose source will not
 * resolve is listed and looks installed, but does nothing. Surfacing the
 * condition beats leaving it for whoever thinks to expand the raw manifest.
 */
const conditionsOf = (item: RegistryObject): readonly Condition[] => {
  const raw = record(item.status).conditions;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry): Condition[] => {
    const source = record(entry);
    const type = stringOf(source, "type");
    const status = stringOf(source, "status");
    if (!type || !status) return [];
    return [
      {
        type,
        status,
        ...(stringOf(source, "reason") ? { reason: stringOf(source, "reason")! } : {}),
        ...(stringOf(source, "message") ? { message: stringOf(source, "message")! } : {}),
      },
    ];
  });
};

/** A condition is a problem when the controller says it is not satisfied. */
const isFailing = (condition: Condition): boolean => condition.status !== "True";

const notReady = (item: RegistryObject): boolean => conditionsOf(item).some(isFailing);

/**
 * The resource re-pinned to a new commit.
 *
 * The existing spec is carried through rather than rebuilt, so fields this UI
 * does not model — anything the registry or another tool added — survive the
 * update. Only the commit and its provenance annotations move.
 */
const repinned = (
  item: RegistryObject,
  kind: GitHubSourcedKind,
  review: ReviewResponse,
): Record<string, unknown> => {
  const spec = { ...record(item.spec) };
  const source = { ...record(spec.source) };
  const nested = source.git !== undefined;
  const repository = { ...record(nested ? record(source.git).repository : source.repository) };
  repository.commit = review.headCommit;
  repository.branch = review.branch;
  spec.source = nested
    ? { ...source, git: { ...record(source.git), repository } }
    : { ...source, repository };
  return {
    apiVersion: item.apiVersion ?? "ar.dev/v1alpha1",
    kind: item.kind ?? (kind === "skills" ? "Skill" : "Plugin"),
    metadata: {
      name: item.metadata?.name,
      ...(item.metadata?.namespace ? { namespace: item.metadata.namespace } : {}),
      ...(item.metadata?.tag ? { tag: item.metadata.tag } : {}),
      annotations: {
        ...record(item.metadata?.annotations),
        "executor.dev/source-commit": review.headCommit,
        "executor.dev/source-branch": review.branch,
        "executor.dev/source-author": review.author,
      },
    },
    spec,
  };
};

const VERDICT_COPY: Record<
  ReviewResponse["security"]["verdict"],
  { readonly headline: string; readonly tone: string }
> = {
  clean: {
    headline: "We think this is safe to run. Do you want to apply the new version?",
    tone: "border-green-500/40 bg-green-500/10 text-green-700 dark:text-green-300",
  },
  review: {
    headline: "This update needs a look before you apply it. Read the findings below, then decide.",
    tone: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  },
  risky: {
    headline:
      "We do not think this is safe to run. Read the findings below before applying anything.",
    tone: "border-destructive/40 bg-destructive/10 text-destructive",
  },
};

const SEVERITY_TONE: Record<SecurityFinding["severity"], string> = {
  high: "bg-destructive/15 text-destructive",
  medium: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  low: "bg-secondary text-secondary-foreground",
};

function RegistryPage() {
  const getConfig = useAtomSet(configMutation, { mode: "promise" });
  const sendRequest = useAtomSet(requestMutation, { mode: "promise" });
  const discoverGithub = useAtomSet(discoverMutation, { mode: "promise" });
  const reviewGithub = useAtomSet(reviewMutation, { mode: "promise" });
  const [baseUrl, setBaseUrl] = useState("AgentRegistry");
  const [authenticated, setAuthenticated] = useState(false);
  const [kind, setKind] = useState<ResourceKind>("mcpservers");
  const [items, setItems] = useState<RegistryObject[]>([]);
  const [selected, setSelected] = useState<RegistryObject | null>(null);
  const [nextCursor, setNextCursor] = useState<string>();
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const [view, setView] = useState<"catalog" | "manifest" | "api">("catalog");
  const [manifest, setManifest] = useState(() => manifestTemplate("mcpservers"));
  const [apiMethod, setApiMethod] = useState<AgentRegistryRequest["method"]>("GET");
  const [apiPath, setApiPath] = useState("/v0/version");
  const [apiQuery, setApiQuery] = useState("{}");
  const [apiBody, setApiBody] = useState("");
  const [apiContentType, setApiContentType] = useState("application/json");
  const [apiResult, setApiResult] = useState<AgentRegistryResponse>();

  // Quick add: a pasted repository URL resolved into selectable candidates.
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const [githubUrl, setGithubUrl] = useState("");
  const [discovery, setDiscovery] = useState<GitHubDiscoverResponse>();
  const [chosen, setChosen] = useState<Record<string, boolean>>({});
  const [names, setNames] = useState<Record<string, string>>({});
  const [namespace, setNamespace] = useState("default");

  // Update review for the selected catalog entry.
  const [review, setReview] = useState<ReviewResponse>();
  const [reviewing, setReviewing] = useState(false);

  const request = useCallback(
    (payload: AgentRegistryRequest) => sendRequest({ payload, reactivityKeys: [] }),
    [sendRequest],
  );

  const resetQuickAdd = useCallback(() => {
    setDiscovery(undefined);
    setChosen({});
    setNames({});
  }, []);

  const load = useCallback(
    async (cursor?: string, append = false) => {
      setLoading(true);
      setError(undefined);
      // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: React event/effect calling the plugin's Promise-mode atom client
      try {
        const response = await request({
          method: "GET",
          path: `/v0/${kind}`,
          query: {
            namespace: "all",
            limit: "100",
            ...(cursor ? { cursor } : {}),
          },
        });
        if (!response.ok) {
          setError(`AgentRegistry returned ${response.status}: ${response.body}`);
          return;
        }
        const payload = parseBody(response);
        const nextItems = extractItems(payload, kind);
        setItems((current) => (append ? [...current, ...nextItems] : nextItems));
        setNextCursor(extractNextCursor(payload));
      } catch (cause) {
        setError(formatError(cause));
      } finally {
        setLoading(false);
      }
    },
    [kind, request],
  );

  useEffect(() => {
    const loadConfig = async () => {
      // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: React effect calling the plugin's Promise-mode atom client
      try {
        const config = await getConfig({ reactivityKeys: [] });
        setBaseUrl(config.baseUrl);
        setAuthenticated(config.authenticated);
      } catch (cause) {
        setError(formatError(cause));
      }
    };
    void loadConfig();
  }, [getConfig]);

  useEffect(() => {
    setSelected(null);
    setManifest(manifestTemplate(kind));
    setQuickAddOpen(false);
    resetQuickAdd();
    void load();
  }, [kind, load, resetQuickAdd]);

  // A review belongs to one resource; showing a stale one against a different
  // selection would attach the wrong diff to the wrong skill.
  useEffect(() => {
    setReview(undefined);
  }, [selected]);

  const filteredItems = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return items;
    return items.filter((item) => JSON.stringify(item).toLowerCase().includes(needle));
  }, [items, search]);

  const applyManifest = async (dryRun: boolean) => {
    setLoading(true);
    setError(undefined);
    setMessage(undefined);
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: React action calling the plugin's Promise-mode atom client
    try {
      const response = await request({
        method: "POST",
        path: "/v0/apply",
        query: dryRun ? { dryRun: "true" } : undefined,
        body: manifest,
        contentType: "application/yaml",
      });
      if (!response.ok) {
        setError(`AgentRegistry returned ${response.status}: ${response.body}`);
        return;
      }
      const operationFailure = applyFailure(response);
      if (operationFailure) {
        setError(operationFailure);
        return;
      }
      setMessage(dryRun ? "Manifest is valid." : "Manifest applied successfully.");
      if (!dryRun) await load();
    } catch (cause) {
      setError(formatError(cause));
    } finally {
      setLoading(false);
    }
  };

  const discover = async () => {
    if (!isGitHubSourced(kind)) return;
    setLoading(true);
    setError(undefined);
    setMessage(undefined);
    resetQuickAdd();
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: React action calling the plugin's Promise-mode atom client
    try {
      const response = await discoverGithub({
        payload: { url: githubUrl, kind },
        reactivityKeys: [],
      });
      setDiscovery(response);
      setChosen(Object.fromEntries(response.candidates.map((entry) => [entry.manifestPath, true])));
      setNames(
        Object.fromEntries(response.candidates.map((entry) => [entry.manifestPath, entry.name])),
      );
    } catch (cause) {
      setError(formatError(cause));
    } finally {
      setLoading(false);
    }
  };

  const applyDiscovered = async () => {
    if (!discovery || !isGitHubSourced(kind)) return;
    const selectedCandidates = discovery.candidates.filter(
      (candidate) => chosen[candidate.manifestPath],
    );
    if (selectedCandidates.length === 0) {
      setError("Select at least one entry to add.");
      return;
    }
    const manifests = selectedCandidates.map((candidate: GitHubCandidate) =>
      toManifest({
        kind,
        namespace: namespace.trim() || "default",
        tag: "latest",
        repositoryUrl: discovery.repositoryUrl,
        branch: discovery.branch,
        commit: discovery.commit,
        author: discovery.author,
        candidate: {
          ...candidate,
          name: toRegistryName(names[candidate.manifestPath] ?? candidate.name),
        },
      }),
    );
    setLoading(true);
    setError(undefined);
    setMessage(undefined);
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: React action calling the plugin's Promise-mode atom client
    try {
      const response = await request({
        method: "POST",
        path: "/v0/apply",
        body: toManifestStream(manifests),
        contentType: "application/yaml",
      });
      if (!response.ok) {
        setError(`AgentRegistry returned ${response.status}: ${response.body}`);
        return;
      }
      const operationFailure = applyFailure(response);
      if (operationFailure) {
        setError(operationFailure);
        return;
      }
      setMessage(
        `Added ${manifests.length} ${manifests.length === 1 ? singularKind[kind] : labels[kind]} from ${discovery.owner}/${discovery.repo}.`,
      );
      setQuickAddOpen(false);
      resetQuickAdd();
      await load();
    } catch (cause) {
      setError(formatError(cause));
    } finally {
      setLoading(false);
    }
  };

  const reviewSelected = async () => {
    if (!selected) return;
    const source = sourceOf(selected);
    if (!source.url) {
      setError("This entry has no git source to compare against.");
      return;
    }
    setReviewing(true);
    setError(undefined);
    setMessage(undefined);
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: React action calling the plugin's Promise-mode atom client
    try {
      setReview(
        await reviewGithub({
          payload: {
            url: source.url,
            ...(source.subfolder ? { subfolder: source.subfolder } : {}),
            ...(source.branch ? { branch: source.branch } : {}),
            ...(source.commit ? { baseCommit: source.commit } : {}),
            ...(source.manifestPath ? { manifestPath: source.manifestPath } : {}),
          },
          reactivityKeys: [],
        }),
      );
    } catch (cause) {
      setError(formatError(cause));
    } finally {
      setReviewing(false);
    }
  };

  const applyReviewed = async () => {
    if (!selected || !review || !isGitHubSourced(kind)) return;
    setLoading(true);
    setError(undefined);
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: React action calling the plugin's Promise-mode atom client
    try {
      const response = await request({
        method: "POST",
        path: "/v0/apply",
        body: JSON.stringify(repinned(selected, kind, review), null, 2),
        contentType: "application/yaml",
      });
      if (!response.ok) {
        setError(`AgentRegistry returned ${response.status}: ${response.body}`);
        return;
      }
      const operationFailure = applyFailure(response);
      if (operationFailure) {
        setError(operationFailure);
        return;
      }
      setMessage(`Updated to ${shortCommit(review.headCommit)}.`);
      setReview(undefined);
      setSelected(null);
      await load();
    } catch (cause) {
      setError(formatError(cause));
    } finally {
      setLoading(false);
    }
  };

  const removeSelected = async () => {
    const metadata = selected?.metadata;
    if (!metadata?.name) return;
    const mutable = kind === "runtimes" || kind === "deployments";
    const suffix = !mutable && metadata.tag ? `/${encodeURIComponent(metadata.tag)}` : "";
    setLoading(true);
    setError(undefined);
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: React action calling the plugin's Promise-mode atom client
    try {
      const response = await request({
        method: "DELETE",
        path: `/v0/${kind}/${encodeURIComponent(metadata.name)}${suffix}`,
        query: metadata.namespace ? { namespace: metadata.namespace } : undefined,
      });
      if (!response.ok) {
        setError(`AgentRegistry returned ${response.status}: ${response.body}`);
        return;
      }
      setSelected(null);
      setMessage(`${singularKind[kind]} deletion requested.`);
      await load();
    } catch (cause) {
      setError(formatError(cause));
    } finally {
      setLoading(false);
    }
  };

  const runApiRequest = async () => {
    setLoading(true);
    setError(undefined);
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: React API console parses user input and calls the Promise-mode atom client
    try {
      // oxlint-disable-next-line executor/no-json-parse -- boundary: user-authored query object in the low-level API console
      const parsedQuery = JSON.parse(apiQuery) as Record<string, unknown>;
      const query = Object.fromEntries(
        Object.entries(parsedQuery).map(([key, value]) => [key, String(value)]),
      );
      const response = await request({
        method: apiMethod,
        path: apiPath,
        query,
        body: apiBody || undefined,
        contentType: apiBody ? apiContentType : undefined,
      });
      setApiResult(response);
    } catch (cause) {
      setError(formatError(cause));
    } finally {
      setLoading(false);
    }
  };

  return (
    <main style={pageStyle} className="bg-background text-foreground">
      <div className="mx-auto flex max-w-7xl flex-col gap-5 px-5 py-6">
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-5">
          <div>
            <h1 className="text-2xl font-semibold">AgentRegistry</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Build, curate, discover, and deploy agents, MCP servers, skills, prompts, models, and
              plugins.
            </p>
            <p className="mt-1 font-mono text-xs text-muted-foreground">
              {baseUrl} · {authenticated ? "authenticated" : "no bearer token"}
            </p>
          </div>
          <div className="flex rounded-md border border-border p-1">
            {(["catalog", "manifest", "api"] as const).map((entry) => (
              <button
                key={entry}
                type="button"
                onClick={() => setView(entry)}
                className={`rounded px-3 py-1.5 text-sm capitalize ${view === entry ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
              >
                {entry === "api" ? "Full API" : entry}
              </button>
            ))}
          </div>
        </header>

        {error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        )}
        {message && (
          <div className="rounded-md border border-green-500/40 bg-green-500/10 px-4 py-3 text-sm text-green-700 dark:text-green-300">
            {message}
          </div>
        )}

        {view === "catalog" && (
          <>
            <div className="flex flex-wrap gap-2">
              {AGENTREGISTRY_RESOURCE_KINDS.map((entry) => (
                <button
                  key={entry}
                  type="button"
                  onClick={() => setKind(entry)}
                  className={`rounded-md border px-3 py-2 text-sm ${kind === entry ? "border-primary bg-primary text-primary-foreground" : "border-border hover:bg-muted"}`}
                >
                  {labels[entry]}
                </button>
              ))}
            </div>

            <div className="flex gap-2">
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={`Search ${labels[kind].toLowerCase()}…`}
                className="min-w-0 flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm"
              />
              <button
                type="button"
                onClick={() => void load()}
                className="rounded-md border border-border px-3 py-2 text-sm hover:bg-muted"
                disabled={loading}
              >
                Refresh
              </button>
              {isGitHubSourced(kind) && (
                <button
                  type="button"
                  onClick={() => setQuickAddOpen((open) => !open)}
                  className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground"
                >
                  Quick add from GitHub
                </button>
              )}
              <button
                type="button"
                onClick={() => setView("manifest")}
                className="rounded-md border border-border px-3 py-2 text-sm hover:bg-muted"
              >
                Add {singularKind[kind]}
              </button>
            </div>

            {quickAddOpen && isGitHubSourced(kind) && (
              <section className="flex flex-col gap-3 rounded-lg border border-border p-4">
                <div>
                  <h2 className="font-semibold">
                    Quick add {labels[kind].toLowerCase()} from GitHub
                  </h2>
                  <p className="text-sm text-muted-foreground">
                    Paste a repository, or a link to a directory inside one. Every{" "}
                    {kind === "skills" ? "SKILL.md" : "plugin"} found is offered below, pinned to
                    the commit it was read from.
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <input
                    aria-label="GitHub URL"
                    value={githubUrl}
                    onChange={(event) => setGithubUrl(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void discover();
                    }}
                    placeholder="https://github.com/owner/repo"
                    className="min-w-0 flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm"
                  />
                  <input
                    aria-label="Namespace"
                    value={namespace}
                    onChange={(event) => setNamespace(event.target.value)}
                    className="w-40 rounded-md border border-input bg-background px-3 py-2 text-sm"
                  />
                  <button
                    type="button"
                    onClick={() => void discover()}
                    className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground"
                    disabled={loading || githubUrl.trim().length === 0}
                  >
                    Find {labels[kind].toLowerCase()}
                  </button>
                </div>

                {discovery && (
                  <>
                    <p className="text-sm text-muted-foreground">
                      {discovery.owner}/{discovery.repo} · {discovery.branch} ·{" "}
                      <span className="font-mono">{shortCommit(discovery.commit)}</span> · last
                      commit by {discovery.author}
                    </p>
                    {discovery.warnings.map((warning) => (
                      <p
                        key={warning}
                        className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300"
                      >
                        {warning}
                      </p>
                    ))}
                    <div className="divide-y divide-border rounded-md border border-border">
                      {discovery.candidates.map((candidate) => (
                        <div key={candidate.manifestPath} className="flex gap-3 p-3">
                          <input
                            type="checkbox"
                            aria-label={`Include ${candidate.manifestPath}`}
                            checked={chosen[candidate.manifestPath] ?? false}
                            onChange={(event) =>
                              setChosen((current) => ({
                                ...current,
                                [candidate.manifestPath]: event.target.checked,
                              }))
                            }
                            className="mt-2"
                          />
                          <div className="flex min-w-0 flex-1 flex-col gap-1">
                            <input
                              aria-label={`Name for ${candidate.manifestPath}`}
                              value={names[candidate.manifestPath] ?? candidate.name}
                              onChange={(event) =>
                                setNames((current) => ({
                                  ...current,
                                  [candidate.manifestPath]: event.target.value,
                                }))
                              }
                              className="rounded-md border border-input bg-background px-2 py-1 font-medium text-sm"
                            />
                            <p className="text-sm text-muted-foreground">
                              {candidate.description || "No description in the source manifest."}
                            </p>
                            <p className="font-mono text-xs text-muted-foreground">
                              {candidate.manifestPath}
                            </p>
                          </div>
                        </div>
                      ))}
                    </div>
                    <div className="flex justify-end">
                      <button
                        type="button"
                        onClick={() => void applyDiscovered()}
                        className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground"
                        disabled={loading}
                      >
                        Add selected
                      </button>
                    </div>
                  </>
                )}
              </section>
            )}

            <div className="grid min-h-[420px] gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(320px,0.8fr)]">
              <section className="overflow-hidden rounded-lg border border-border">
                {loading && items.length === 0 ? (
                  <p className="p-5 text-sm text-muted-foreground">Loading…</p>
                ) : filteredItems.length === 0 ? (
                  <p className="p-5 text-sm text-muted-foreground">
                    No {labels[kind].toLowerCase()} found.
                  </p>
                ) : (
                  <div className="divide-y divide-border">
                    {filteredItems.map((item, index) => {
                      const metadata = item.metadata ?? {};
                      const key = `${metadata.namespace ?? "default"}/${metadata.name ?? index}@${metadata.tag ?? ""}`;
                      const source = sourceOf(item);
                      const description = describe(item);
                      return (
                        <button
                          key={key}
                          type="button"
                          onClick={() => setSelected(item)}
                          className={`w-full px-4 py-3 text-left hover:bg-muted ${selected === item ? "bg-muted" : ""}`}
                        >
                          <div className="flex items-center justify-between gap-3">
                            <span className="font-medium">
                              {titleOf(item) ?? metadata.name ?? item.kind ?? "Unnamed"}
                            </span>
                            {metadata.tag && (
                              <span className="rounded bg-secondary px-2 py-0.5 font-mono text-xs">
                                {metadata.tag}
                              </span>
                            )}
                          </div>
                          {description && (
                            <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                              {description}
                            </p>
                          )}
                          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                            <span>{metadata.namespace || "default"}</span>
                            {source.author && <span>by {source.author}</span>}
                            {metadata.updatedAt && (
                              <span>Updated {new Date(metadata.updatedAt).toLocaleString()}</span>
                            )}
                            {source.commit && (
                              <span className="font-mono">{shortCommit(source.commit)}</span>
                            )}
                            {notReady(item) && (
                              <span className="font-medium text-destructive">not ready</span>
                            )}
                            {metadata.deletionTimestamp && (
                              <span className="text-destructive">deleting</span>
                            )}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
                {nextCursor && (
                  <button
                    type="button"
                    onClick={() => void load(nextCursor, true)}
                    className="w-full border-t border-border px-4 py-3 text-sm hover:bg-muted"
                    disabled={loading}
                  >
                    Load more
                  </button>
                )}
              </section>

              <aside className="rounded-lg border border-border">
                {selected ? (
                  <div className="flex h-full flex-col">
                    <div className="flex items-center justify-between border-b border-border px-4 py-3">
                      <div>
                        <h2 className="font-semibold">
                          {selected.metadata?.name ?? selected.kind}
                        </h2>
                        <p className="text-xs text-muted-foreground">
                          {selected.kind}{" "}
                          {selected.metadata?.tag ? `@ ${selected.metadata.tag}` : ""}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => void removeSelected()}
                        className="rounded-md border border-destructive/50 px-3 py-1.5 text-xs text-destructive hover:bg-destructive/10"
                        disabled={loading}
                      >
                        Delete
                      </button>
                    </div>
                    <div className="min-h-0 flex-1 overflow-auto">
                      {(() => {
                        const source = sourceOf(selected);
                        const description = describe(selected);
                        return (
                          <div className="flex flex-col gap-4 p-4">
                            {conditionsOf(selected)
                              .filter(isFailing)
                              .map((condition) => (
                                <div
                                  key={condition.type}
                                  className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
                                >
                                  <p className="font-semibold">
                                    {condition.type}: {condition.status}
                                    {condition.reason ? ` — ${condition.reason}` : ""}
                                  </p>
                                  {condition.message && (
                                    <p className="mt-1 font-mono text-xs break-words">
                                      {condition.message}
                                    </p>
                                  )}
                                </div>
                              ))}
                            {description && <p className="text-sm">{description}</p>}
                            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
                              {source.author && (
                                <>
                                  <dt className="text-muted-foreground">Author</dt>
                                  <dd>{source.author}</dd>
                                </>
                              )}
                              {source.url && (
                                <>
                                  <dt className="text-muted-foreground">Source</dt>
                                  <dd className="break-all">
                                    {source.url}
                                    {source.subfolder ? `/${source.subfolder}` : ""}
                                  </dd>
                                </>
                              )}
                              {source.branch && (
                                <>
                                  <dt className="text-muted-foreground">Branch</dt>
                                  <dd>{source.branch}</dd>
                                </>
                              )}
                              {source.commit && (
                                <>
                                  <dt className="text-muted-foreground">Pinned commit</dt>
                                  <dd className="font-mono">{shortCommit(source.commit)}</dd>
                                </>
                              )}
                              {selected.metadata?.updatedAt && (
                                <>
                                  <dt className="text-muted-foreground">Last updated</dt>
                                  <dd>{new Date(selected.metadata.updatedAt).toLocaleString()}</dd>
                                </>
                              )}
                            </dl>

                            {isGitHubSourced(kind) && source.url && (
                              <button
                                type="button"
                                onClick={() => void reviewSelected()}
                                className="self-start rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted"
                                disabled={reviewing}
                              >
                                {reviewing ? "Checking…" : "Check for updates"}
                              </button>
                            )}

                            {review && (
                              <section className="flex flex-col gap-3 rounded-md border border-border p-3">
                                <div>
                                  <h3 className="text-sm font-semibold">
                                    {review.upToDate
                                      ? "Already up to date"
                                      : "Upstream has changed"}
                                  </h3>
                                  <p className="mt-1 text-xs text-muted-foreground">
                                    {shortCommit(review.baseCommit) ?? "unpinned"} →{" "}
                                    <span className="font-mono">
                                      {shortCommit(review.headCommit)}
                                    </span>
                                    {" · "}
                                    {review.author}
                                    {review.authoredAt
                                      ? ` · ${new Date(review.authoredAt).toLocaleString()}`
                                      : ""}
                                  </p>
                                  {review.commitSubject && (
                                    <p className="mt-1 text-xs italic text-muted-foreground">
                                      {review.commitSubject}
                                    </p>
                                  )}
                                </div>

                                <div>
                                  <h4 className="text-xs font-semibold uppercase text-muted-foreground">
                                    What changed
                                  </h4>
                                  <ul className="mt-1 list-disc space-y-1 pl-4 text-sm">
                                    {review.changes.map((change) => (
                                      <li key={change}>{change}</li>
                                    ))}
                                  </ul>
                                </div>

                                {!review.upToDate && (
                                  <>
                                    <div>
                                      <h4 className="text-xs font-semibold uppercase text-muted-foreground">
                                        Security check
                                      </h4>
                                      {review.security.findings.length === 0 ? (
                                        <p className="mt-1 text-sm">
                                          No known-risky patterns were found in the added lines.
                                        </p>
                                      ) : (
                                        <ul className="mt-1 space-y-2">
                                          {review.security.findings.map((finding) => (
                                            <li
                                              key={`${finding.title}:${finding.path}`}
                                              className="rounded-md border border-border p-2"
                                            >
                                              <div className="flex items-center gap-2">
                                                <span
                                                  className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${SEVERITY_TONE[finding.severity]}`}
                                                >
                                                  {finding.severity}
                                                </span>
                                                <span className="text-sm font-medium">
                                                  {finding.title}
                                                </span>
                                              </div>
                                              <p className="mt-1 font-mono text-xs break-all text-muted-foreground">
                                                {finding.path}: {finding.evidence}
                                              </p>
                                            </li>
                                          ))}
                                        </ul>
                                      )}
                                      <p className="mt-2 text-xs text-muted-foreground">
                                        This is a pattern scan of the added lines, not a full
                                        review. Read the diff yourself for anything you do not
                                        recognise.
                                      </p>
                                    </div>

                                    <div
                                      className={`rounded-md border px-3 py-2 text-sm ${VERDICT_COPY[review.security.verdict].tone}`}
                                    >
                                      {VERDICT_COPY[review.security.verdict].headline}
                                    </div>
                                    <div className="flex justify-end gap-2">
                                      <button
                                        type="button"
                                        onClick={() => setReview(undefined)}
                                        className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted"
                                      >
                                        Not now
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => void applyReviewed()}
                                        className={`rounded-md px-3 py-1.5 text-sm ${review.security.verdict === "risky" ? "bg-destructive text-destructive-foreground" : "bg-primary text-primary-foreground"}`}
                                        disabled={loading}
                                      >
                                        Apply new version
                                      </button>
                                    </div>
                                  </>
                                )}
                              </section>
                            )}

                            <details>
                              <summary className="cursor-pointer text-xs text-muted-foreground">
                                Raw manifest
                              </summary>
                              <pre className="mt-2 overflow-auto whitespace-pre-wrap break-words text-xs">
                                {JSON.stringify(selected, null, 2)}
                              </pre>
                            </details>
                          </div>
                        );
                      })()}
                    </div>
                  </div>
                ) : (
                  <p className="p-5 text-sm text-muted-foreground">
                    Select a resource to inspect its metadata, spec, and controller status.
                  </p>
                )}
              </aside>
            </div>
          </>
        )}

        {view === "manifest" && (
          <section className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">Declarative apply</h2>
                <p className="text-sm text-muted-foreground">
                  Apply JSON or multi-document YAML for any AgentRegistry kind.
                </p>
              </div>
              <select
                aria-label="Resource kind"
                value={kind}
                onChange={(event) => setKind(event.target.value as ResourceKind)}
                className="rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                {AGENTREGISTRY_RESOURCE_KINDS.map((entry) => (
                  <option key={entry} value={entry}>
                    {labels[entry]}
                  </option>
                ))}
              </select>
            </div>
            <textarea
              aria-label="AgentRegistry manifest"
              value={manifest}
              onChange={(event) => setManifest(event.target.value)}
              spellCheck={false}
              className="min-h-[480px] rounded-lg border border-input bg-background p-4 font-mono text-sm"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => void applyManifest(true)}
                className="rounded-md border border-border px-4 py-2 text-sm hover:bg-muted"
                disabled={loading}
              >
                Validate (dry run)
              </button>
              <button
                type="button"
                onClick={() => void applyManifest(false)}
                className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground"
                disabled={loading}
              >
                Apply manifest
              </button>
            </div>
          </section>
        )}

        {view === "api" && (
          <section className="grid gap-4 lg:grid-cols-2">
            <div className="flex flex-col gap-3 rounded-lg border border-border p-4">
              <div>
                <h2 className="text-lg font-semibold">Complete AgentRegistry API</h2>
                <p className="text-sm text-muted-foreground">
                  Access native CRUD, MCP Registry compatibility, deployment logs, metrics, health,
                  and logging operations.
                </p>
              </div>
              <div className="flex gap-2">
                <select
                  aria-label="HTTP method"
                  value={apiMethod}
                  onChange={(event) =>
                    setApiMethod(event.target.value as AgentRegistryRequest["method"])
                  }
                  className="rounded-md border border-input bg-background px-3 py-2 font-mono text-sm"
                >
                  {(["GET", "POST", "PUT", "PATCH", "DELETE"] as const).map((method) => (
                    <option key={method}>{method}</option>
                  ))}
                </select>
                <input
                  aria-label="API path"
                  value={apiPath}
                  onChange={(event) => setApiPath(event.target.value)}
                  className="min-w-0 flex-1 rounded-md border border-input bg-background px-3 py-2 font-mono text-sm"
                />
              </div>
              <label className="text-sm font-medium">Query parameters (JSON object)</label>
              <textarea
                aria-label="Query parameters"
                value={apiQuery}
                onChange={(event) => setApiQuery(event.target.value)}
                className="min-h-24 rounded-md border border-input bg-background p-3 font-mono text-sm"
              />
              <label className="text-sm font-medium">Request body (JSON or YAML)</label>
              <select
                aria-label="Request content type"
                value={apiContentType}
                onChange={(event) => setApiContentType(event.target.value)}
                className="rounded-md border border-input bg-background px-3 py-2 font-mono text-sm"
              >
                <option value="application/json">application/json</option>
                <option value="application/yaml">application/yaml</option>
                <option value="text/plain">text/plain</option>
              </select>
              <textarea
                aria-label="Request body"
                value={apiBody}
                onChange={(event) => setApiBody(event.target.value)}
                className="min-h-48 rounded-md border border-input bg-background p-3 font-mono text-sm"
              />
              <button
                type="button"
                onClick={() => void runApiRequest()}
                className="self-end rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground"
                disabled={loading}
              >
                Send request
              </button>
            </div>
            <div className="overflow-hidden rounded-lg border border-border">
              <div className="border-b border-border px-4 py-3 text-sm font-medium">
                Response {apiResult ? `· ${apiResult.status} ${apiResult.ok ? "OK" : "Error"}` : ""}
              </div>
              <pre className="max-h-[650px] overflow-auto whitespace-pre-wrap break-words p-4 text-xs">
                {apiResult
                  ? typeof parseBody(apiResult) === "string"
                    ? apiResult.body
                    : JSON.stringify(parseBody(apiResult), null, 2)
                  : "Send a request to inspect the native response."}
              </pre>
            </div>
          </section>
        )}
      </div>
    </main>
  );
}

export default defineClientPlugin({
  id: "agentregistry" as const,
  pages: [
    {
      path: "/",
      component: RegistryPage,
      nav: { label: "AgentRegistry" },
    },
  ],
});
