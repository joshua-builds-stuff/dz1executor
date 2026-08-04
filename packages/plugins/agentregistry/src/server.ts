import { Context, Effect, HttpApiBuilder, Schema } from "@executor-js/sdk/core";
import { definePlugin, tool, type StaticToolSchema } from "@executor-js/sdk/core";
import { addGroup } from "@executor-js/api";

import {
  AGENTREGISTRY_RESOURCE_KINDS,
  AgentRegistryApi,
  AgentRegistryError,
  type AgentRegistryRequest,
  type AgentRegistryResponse,
} from "./shared";

export interface AgentRegistryPluginOptions {
  /** AgentRegistry server origin. Defaults to AGENTREGISTRY_URL or the local default. */
  readonly baseUrl?: string;
  /** Optional bearer token. Defaults to AGENTREGISTRY_TOKEN and is never sent to the browser. */
  readonly token?: string;
  /** Executor browser origin used by the agent-facing handoff tool. */
  readonly webBaseUrl?: string;
}

interface ResolvedOptions {
  readonly baseUrl: string;
  readonly token?: string;
  readonly webBaseUrl?: string;
}

const resolveOptions = (options: AgentRegistryPluginOptions): ResolvedOptions => ({
  baseUrl: (options.baseUrl ?? process.env.AGENTREGISTRY_URL ?? "http://127.0.0.1:12121").replace(
    /\/$/,
    "",
  ),
  token: options.token ?? process.env.AGENTREGISTRY_TOKEN,
  webBaseUrl: options.webBaseUrl,
});

const allowedRootPaths = new Set(["/health", "/healthz", "/metrics", "/logging"]);

export const validateAgentRegistryPath = (path: string): string => {
  if (!path.startsWith("/") || path.includes("\\") || path.includes("?") || path.includes("#")) {
    // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: synchronous path validator is called inside Effect.tryPromise
    throw new Error("path must be an absolute AgentRegistry path without a query string");
  }
  let decoded: string;
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: decodeURIComponent is a throwing platform API wrapped by the caller's Effect.tryPromise
  try {
    decoded = decodeURIComponent(path);
  } catch {
    // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: normalize platform exception for Effect.tryPromise
    throw new Error("path contains invalid percent encoding");
  }
  if (decoded.split("/").includes("..") || path.startsWith("//")) {
    // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: synchronous path validator is called inside Effect.tryPromise
    throw new Error("path traversal is not allowed");
  }
  if (!path.startsWith("/v0/") && !path.startsWith("/v0.1/") && !allowedRootPaths.has(path)) {
    // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: synchronous path validator is called inside Effect.tryPromise
    throw new Error("only AgentRegistry API, health, metrics, and logging paths are allowed");
  }
  return path;
};

export const requestAgentRegistry = (
  options: ResolvedOptions,
  input: AgentRegistryRequest,
): Effect.Effect<AgentRegistryResponse, AgentRegistryError> =>
  Effect.tryPromise({
    try: async () => {
      const path = validateAgentRegistryPath(input.path);
      const url = new URL(path, `${options.baseUrl}/`);
      for (const [key, value] of Object.entries(input.query ?? {})) {
        url.searchParams.set(key, value);
      }
      const headers = new Headers({ Accept: "application/json, application/yaml, text/plain" });
      if (options.token) headers.set("Authorization", `Bearer ${options.token}`);
      if (input.body !== undefined) {
        headers.set("Content-Type", input.contentType ?? "application/json");
      }
      const response = await fetch(url, {
        method: input.method,
        headers,
        body: input.body,
        redirect: "error",
      });
      return {
        ok: response.ok,
        status: response.status,
        contentType: response.headers.get("content-type") ?? "text/plain",
        body: await response.text(),
      };
    },
    catch: (cause) =>
      new AgentRegistryError({
        message: String(cause || "AgentRegistry request failed"),
      }),
  });

const AgentRegistryApiBundle = addGroup(AgentRegistryApi);

const makeAgentRegistryExtension = (options: ResolvedOptions) => ({
  config: () =>
    Effect.succeed({
      baseUrl: options.baseUrl,
      configured: options.baseUrl.length > 0,
      authenticated: options.token !== undefined && options.token.length > 0,
      resourceKinds: [...AGENTREGISTRY_RESOURCE_KINDS],
    }),
  request: (input: AgentRegistryRequest) => requestAgentRegistry(options, input),
});

type AgentRegistryExtension = ReturnType<typeof makeAgentRegistryExtension>;

export class AgentRegistryExtensionService extends Context.Service<
  AgentRegistryExtensionService,
  AgentRegistryExtension
>()("AgentRegistryExtensionService") {}

const AgentRegistryHandlers = HttpApiBuilder.group(
  AgentRegistryApiBundle,
  "agentregistry",
  (handlers) =>
    handlers
      .handle("config", () =>
        Effect.gen(function* () {
          const extension = yield* AgentRegistryExtensionService;
          return yield* extension.config();
        }),
      )
      .handle("request", ({ payload }) =>
        Effect.gen(function* () {
          const extension = yield* AgentRegistryExtensionService;
          return yield* extension.request(payload);
        }),
      ),
);

const schemaToStaticToolSchema = <A, I>(schema: Schema.Decoder<A, I>): StaticToolSchema<A, I> =>
  Schema.toStandardSchemaV1(Schema.toStandardJSONSchemaV1(schema) as never) as StaticToolSchema<
    A,
    I
  >;

const ResourceKind = Schema.Literals(AGENTREGISTRY_RESOURCE_KINDS);
const RequestInput = schemaToStaticToolSchema(
  Schema.Struct({
    method: Schema.Literals(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    path: Schema.String,
    query: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    body: Schema.optional(Schema.String),
    contentType: Schema.optional(Schema.String),
  }),
);
const ListInput = schemaToStaticToolSchema(
  Schema.Struct({
    kind: ResourceKind,
    namespace: Schema.optional(Schema.String),
    search: Schema.optional(Schema.String),
    labels: Schema.optional(Schema.String),
    origin: Schema.optional(Schema.String),
    limit: Schema.optional(Schema.Number),
    cursor: Schema.optional(Schema.String),
  }),
);
const GetInput = schemaToStaticToolSchema(
  Schema.Struct({
    kind: ResourceKind,
    name: Schema.String,
    tag: Schema.optional(Schema.String),
    namespace: Schema.optional(Schema.String),
  }),
);
const ManifestInput = schemaToStaticToolSchema(
  Schema.Struct({ manifest: Schema.String, dryRun: Schema.optional(Schema.Boolean) }),
);
const DeleteInput = schemaToStaticToolSchema(
  Schema.Struct({
    kind: ResourceKind,
    name: Schema.String,
    tag: Schema.optional(Schema.String),
    namespace: Schema.optional(Schema.String),
  }),
);
const LogsInput = schemaToStaticToolSchema(
  Schema.Struct({ name: Schema.String, namespace: Schema.optional(Schema.String) }),
);
const ToolResponse = schemaToStaticToolSchema(
  Schema.Struct({
    ok: Schema.Boolean,
    status: Schema.Number,
    contentType: Schema.String,
    body: Schema.String,
  }),
);
const BrowserOutput = schemaToStaticToolSchema(
  Schema.Struct({ url: Schema.String, instructions: Schema.String }),
);

type Kind = (typeof AGENTREGISTRY_RESOURCE_KINDS)[number];

const encodedResourcePath = (kind: Kind, name: string, tag?: string): string => {
  const base = `/v0/${kind}/${encodeURIComponent(name)}`;
  return tag && kind !== "runtimes" && kind !== "deployments"
    ? `${base}/${encodeURIComponent(tag)}`
    : base;
};

export const agentRegistryPlugin = definePlugin((input: AgentRegistryPluginOptions = {}) => {
  const options = resolveOptions(input);
  return {
    id: "agentregistry" as const,
    packageName: "@executor-js/plugin-agentregistry",
    storage: () => ({}),
    extension: () => makeAgentRegistryExtension(options),
    routes: () => AgentRegistryApi,
    handlers: () => AgentRegistryHandlers,
    extensionService: AgentRegistryExtensionService,
    staticIntegrations: (extension: AgentRegistryExtension) => [
      {
        id: "agentregistry.registry",
        kind: "executor",
        name: "AgentRegistry",
        tools: [
          tool({
            name: "request",
            description:
              "Call any AgentRegistry API operation. Paths are restricted to the AgentRegistry /v0, /v0.1, health, metrics, and logging surfaces. This is the complete low-level escape hatch for operations not covered by a semantic tool.",
            inputSchema: RequestInput,
            outputSchema: ToolResponse,
            annotations: { requiresApproval: true },
            execute: (request: AgentRegistryRequest) => extension.request(request),
          }),
          tool({
            name: "resources.list",
            description:
              "Discover AgentRegistry agents, MCP servers, skills, prompts, models, plugins, runtimes, or deployments, with namespace, search, labels, origin, and cursor filters.",
            inputSchema: ListInput,
            outputSchema: ToolResponse,
            execute: (args: {
              kind: Kind;
              namespace?: string;
              search?: string;
              labels?: string;
              origin?: string;
              limit?: number;
              cursor?: string;
            }) => {
              const query = Object.fromEntries(
                Object.entries({
                  namespace: args.namespace,
                  search: args.search,
                  labels: args.labels,
                  origin: args.origin,
                  limit: args.limit?.toString(),
                  cursor: args.cursor,
                }).filter((entry): entry is [string, string] => entry[1] !== undefined),
              );
              return extension.request({ method: "GET", path: `/v0/${args.kind}`, query });
            },
          }),
          tool({
            name: "resources.get",
            description:
              "Get the latest or a tagged AgentRegistry resource. Runtime and Deployment resources are mutable and ignore tag.",
            inputSchema: GetInput,
            outputSchema: ToolResponse,
            execute: (args: { kind: Kind; name: string; tag?: string; namespace?: string }) =>
              extension.request({
                method: "GET",
                path: encodedResourcePath(args.kind, args.name, args.tag),
                query: args.namespace ? { namespace: args.namespace } : undefined,
              }),
          }),
          tool({
            name: "resources.apply",
            description:
              "Apply one or more AgentRegistry v1alpha1 YAML/JSON manifests. Supports every registered kind and multi-document YAML. Use dryRun to validate without persisting.",
            inputSchema: ManifestInput,
            outputSchema: ToolResponse,
            annotations: { requiresApproval: true },
            execute: (args: { manifest: string; dryRun?: boolean }) =>
              extension.request({
                method: "POST",
                path: "/v0/apply",
                query: args.dryRun ? { dryRun: "true" } : undefined,
                body: args.manifest,
                contentType: "application/yaml",
              }),
          }),
          tool({
            name: "resources.deleteBatch",
            description:
              "Delete one or more AgentRegistry resources described by a multi-document v1alpha1 YAML/JSON manifest. Use dryRun to validate without deleting.",
            inputSchema: ManifestInput,
            outputSchema: ToolResponse,
            annotations: { requiresApproval: true },
            execute: (args: { manifest: string; dryRun?: boolean }) =>
              extension.request({
                method: "DELETE",
                path: "/v0/apply",
                query: args.dryRun ? { dryRun: "true" } : undefined,
                body: args.manifest,
                contentType: "application/yaml",
              }),
          }),
          tool({
            name: "resources.delete",
            description:
              "Soft-delete one AgentRegistry resource. Tagged content kinds require tag; runtimes and deployments are deleted by name.",
            inputSchema: DeleteInput,
            outputSchema: ToolResponse,
            annotations: { requiresApproval: true },
            execute: (args: { kind: Kind; name: string; tag?: string; namespace?: string }) =>
              extension.request({
                method: "DELETE",
                path: encodedResourcePath(args.kind, args.name, args.tag),
                query: args.namespace ? { namespace: args.namespace } : undefined,
              }),
          }),
          tool({
            name: "deployments.logs",
            description: "Read logs for an AgentRegistry-managed deployment.",
            inputSchema: LogsInput,
            outputSchema: ToolResponse,
            execute: (args: { name: string; namespace?: string }) =>
              extension.request({
                method: "GET",
                path: `/v0/deployments/${encodeURIComponent(args.name)}/logs`,
                query: args.namespace ? { namespace: args.namespace } : undefined,
              }),
          }),
          tool({
            name: "health",
            description: "Check AgentRegistry health and return its full health payload.",
            outputSchema: ToolResponse,
            execute: () => extension.request({ method: "GET", path: "/v0/health" }),
          }),
          tool({
            name: "openConsole",
            description:
              "Return the Executor web UI URL for browsing, applying, deploying, and deleting AgentRegistry resources.",
            outputSchema: BrowserOutput,
            execute: () => {
              const path = "/plugins/agentregistry/";
              const url = options.webBaseUrl
                ? new URL(path, `${options.webBaseUrl.replace(/\/$/, "")}/`).toString()
                : path;
              return Effect.succeed({
                url,
                instructions:
                  "Open this URL in Executor to manage the complete AgentRegistry catalog and deployment surface.",
              });
            },
          }),
        ],
      },
    ],
  };
});

export default agentRegistryPlugin;
