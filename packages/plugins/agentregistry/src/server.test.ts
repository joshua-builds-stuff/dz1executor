import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { agentRegistryPlugin, requestAgentRegistry, validateAgentRegistryPath } from "./server";

describe("agentRegistryPlugin", () => {
  it("contributes the complete AgentRegistry MCP surface", () => {
    const plugin = agentRegistryPlugin();
    const extension = plugin.extension!({} as never);
    const integrations = plugin.staticIntegrations!(extension);
    expect(integrations).toHaveLength(1);
    expect(integrations[0]?.tools.map((tool) => tool.name)).toEqual([
      "request",
      "resources.list",
      "resources.get",
      "resources.apply",
      "resources.deleteBatch",
      "resources.delete",
      "deployments.logs",
      "health",
      "openConsole",
    ]);
  });

  it("restricts proxy calls to AgentRegistry-owned paths", () => {
    expect(validateAgentRegistryPath("/v0/agents")).toBe("/v0/agents");
    expect(validateAgentRegistryPath("/v0.1/servers")).toBe("/v0.1/servers");
    expect(validateAgentRegistryPath("/metrics")).toBe("/metrics");
    expect(() => validateAgentRegistryPath("https://attacker.invalid/v0/agents")).toThrow();
    expect(() => validateAgentRegistryPath("/v0/../admin")).toThrow();
    expect(() => validateAgentRegistryPath("/v0/agents?namespace=all")).toThrow();
  });

  it.effect("forwards query, body, and server-side authentication", () =>
    Effect.acquireUseRelease(
      Effect.callback<Server>((resume) => {
        const server = createServer((request, response) => {
          const chunks: Buffer[] = [];
          request.on("data", (chunk: Buffer) => chunks.push(chunk));
          request.on("end", () => {
            const url = new URL(request.url ?? "/", "http://localhost");
            response.setHeader("content-type", "application/json");
            response.end(
              JSON.stringify({
                method: request.method,
                path: url.pathname,
                query: Object.fromEntries(url.searchParams),
                authorization: request.headers.authorization ?? null,
                body: Buffer.concat(chunks).toString("utf8"),
              }),
            );
          });
        });
        server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
      }),
      (server) =>
        requestAgentRegistry(
          {
            baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
            token: "secret-token",
          },
          {
            method: "POST",
            path: "/v0/apply",
            query: { dryRun: "true" },
            body: "kind: Agent",
            contentType: "application/yaml",
          },
        ).pipe(
          Effect.map((response) => {
            expect(response.ok).toBe(true);
            // oxlint-disable-next-line executor/no-json-parse -- test boundary: inspect the fake HTTP server's JSON wire response
            expect(JSON.parse(response.body)).toEqual({
              method: "POST",
              path: "/v0/apply",
              query: { dryRun: "true" },
              authorization: "Bearer secret-token",
              body: "kind: Agent",
            });
          }),
        ),
      (server) =>
        Effect.callback<void>((resume) => {
          server.close(() => resume(Effect.void));
        }),
    ),
  );
});
