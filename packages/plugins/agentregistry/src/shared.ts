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
