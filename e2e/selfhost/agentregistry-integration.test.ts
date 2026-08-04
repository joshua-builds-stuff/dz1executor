import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Browser, Mcp, Target } from "../src/services";

const agentRegistryUrl = process.env.AGENTREGISTRY_URL ?? "http://127.0.0.1:12121";

const removePrompt = (name: string): Effect.Effect<void> =>
  Effect.promise(() =>
    fetch(new URL(`/v0/prompts/${encodeURIComponent(name)}/latest`, agentRegistryUrl), {
      method: "DELETE",
    }).then(() => undefined),
  ).pipe(Effect.ignore);

scenario(
  "AgentRegistry · self-host WebUI and MCP expose the registry",
  { timeout: 180_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const mcp = yield* Mcp;
    const identity = yield* target.newIdentity();
    const name = `executor-e2e-prompt-${randomBytes(5).toString("hex")}`;
    const manifest = JSON.stringify(
      {
        apiVersion: "ar.dev/v1alpha1",
        kind: "Prompt",
        metadata: { name, tag: "latest" },
        spec: {
          description: "Created through the Executor AgentRegistry WebUI",
          content: "Return a concise integration status.",
        },
      },
      null,
      2,
    );

    yield* Effect.gen(function* () {
      yield* browser.session(identity, async ({ page, step }) => {
        await step("Open the AgentRegistry plugin page", async () => {
          await page.goto("/plugins/agentregistry/", { waitUntil: "domcontentloaded" });
          await page.getByRole("heading", { name: "AgentRegistry" }).waitFor();
          await page.getByText(agentRegistryUrl, { exact: false }).waitFor();
          await page.getByRole("button", { name: "MCP Servers" }).waitFor();
        });

        await step("Check native AgentRegistry health through the full API console", async () => {
          await page.getByRole("button", { name: "Full API" }).click();
          await page.getByLabel("API path").fill("/v0/health");
          await page.getByLabel("Query parameters").fill("{}");
          await page.getByRole("button", { name: "Send request" }).click();
          await page.getByText("Response · 200 OK").waitFor();
        });

        await step("Validate and apply a Prompt manifest", async () => {
          await page.getByRole("button", { name: "Manifest" }).click();
          await page.getByLabel("Resource kind").selectOption("prompts");
          await page.getByLabel("AgentRegistry manifest").fill(manifest);
          await page.getByRole("button", { name: "Validate (dry run)" }).click();
          await page.getByText("Manifest is valid.").waitFor();
          await page.getByRole("button", { name: "Apply manifest" }).click();
          await page.getByText("Manifest applied successfully.").waitFor();
        });

        await step("Find and inspect the created Prompt in the catalog", async () => {
          await page.getByRole("button", { name: "Catalog" }).click();
          await page.getByPlaceholder("Search prompts…").fill(name);
          await page.getByRole("button", { name, exact: false }).click();
          await page.getByRole("heading", { name }).waitFor();
          await page.getByText("Return a concise integration status.").waitFor();
        });

        await step("Delete the Prompt from Executor", async () => {
          await page.getByRole("button", { name: "Delete" }).click();
          await page.getByText("Prompt deletion requested.").waitFor();
        });
      });

      const session = mcp.session(identity);
      const tools = yield* session.describeTools();
      const execute = tools.find((entry) => entry.name === "execute");
      expect(execute, "self-host MCP advertises Executor's execute surface").toBeDefined();

      const health = yield* session.call("execute", {
        code: `
const result = await tools.executor.agentregistry.registry.health({});
if (!result.ok) throw new Error(result.error.message);
return { ok: result.data.ok, status: result.data.status };
`,
      });
      expect(health.ok, `AgentRegistry health executes over MCP; response:\n${health.text}`).toBe(
        true,
      );
      expect(health.text).toContain("200");
    }).pipe(Effect.ensuring(removePrompt(name)));
  }),
);
