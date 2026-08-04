/* oxlint-disable react/forbid-elements -- standalone plugin UI follows the public plugin SDK convention */
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { createPluginAtomClient, defineClientPlugin, useAtomSet } from "@executor-js/sdk/client";

import {
  AGENTREGISTRY_RESOURCE_KINDS,
  AgentRegistryApi,
  type AgentRegistryRequest,
  type AgentRegistryResponse,
} from "./shared";

const AgentRegistryClient = createPluginAtomClient(AgentRegistryApi);
const configMutation = AgentRegistryClient.mutation("agentregistry", "config");
const requestMutation = AgentRegistryClient.mutation("agentregistry", "request");

type ResourceKind = (typeof AGENTREGISTRY_RESOURCE_KINDS)[number];
type RegistryObject = {
  readonly apiVersion?: string;
  readonly kind?: string;
  readonly metadata?: {
    readonly namespace?: string;
    readonly name?: string;
    readonly tag?: string;
    readonly labels?: Readonly<Record<string, string>>;
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

function RegistryPage() {
  const getConfig = useAtomSet(configMutation, { mode: "promise" });
  const sendRequest = useAtomSet(requestMutation, { mode: "promise" });
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

  const request = useCallback(
    (payload: AgentRegistryRequest) => sendRequest({ payload, reactivityKeys: [] }),
    [sendRequest],
  );

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
    void load();
  }, [kind, load]);

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
              <button
                type="button"
                onClick={() => setView("manifest")}
                className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground"
              >
                Add {singularKind[kind]}
              </button>
            </div>

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
                      return (
                        <button
                          key={key}
                          type="button"
                          onClick={() => setSelected(item)}
                          className={`w-full px-4 py-3 text-left hover:bg-muted ${selected === item ? "bg-muted" : ""}`}
                        >
                          <div className="flex items-center justify-between gap-3">
                            <span className="font-medium">
                              {metadata.name ?? item.kind ?? "Unnamed"}
                            </span>
                            {metadata.tag && (
                              <span className="rounded bg-secondary px-2 py-0.5 font-mono text-xs">
                                {metadata.tag}
                              </span>
                            )}
                          </div>
                          <div className="mt-1 flex gap-3 text-xs text-muted-foreground">
                            <span>{metadata.namespace || "default"}</span>
                            {metadata.deletionTimestamp && (
                              <span className="text-destructive">deleting</span>
                            )}
                            {metadata.updatedAt && (
                              <span>{new Date(metadata.updatedAt).toLocaleString()}</span>
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
                    <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-4 text-xs">
                      {JSON.stringify(selected, null, 2)}
                    </pre>
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
