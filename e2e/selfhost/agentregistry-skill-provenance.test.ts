import { randomBytes } from "node:crypto";

import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Browser, Target } from "../src/services";

// The GitHub-sourced surface of the AgentRegistry page: what a git-backed Skill
// shows in the catalog, and how quick add reports a URL it cannot use.
//
// Resolving a real repository is deliberately out of scope here. The GitHub
// emulator does not implement the git-data endpoints this feature reads
// (trees, contents, compare), and AGENTS.md forbids standing up a parallel fake
// beside it — so the happy path is covered by unit tests over the pure
// discovery/review logic plus manual verification, and this scenario asserts
// the product contract that does not need upstream: provenance rendering, and
// the rejection path, which fails on URL parsing before any network call.

const agentRegistryUrl = process.env.AGENTREGISTRY_URL ?? "http://127.0.0.1:12121";

const applySkill = (name: string): Effect.Effect<void> =>
  Effect.promise(() =>
    fetch(new URL("/v0/apply", agentRegistryUrl), {
      method: "POST",
      headers: { "Content-Type": "application/yaml" },
      body: JSON.stringify({
        apiVersion: "ar.dev/v1alpha1",
        kind: "Skill",
        metadata: {
          name,
          tag: "latest",
          annotations: {
            "executor.dev/source-url": "https://github.com/executor-e2e/skills",
            "executor.dev/source-branch": "main",
            "executor.dev/source-commit": "0123456789abcdef0123456789abcdef01234567",
            "executor.dev/source-author": "e2e-author",
            "executor.dev/source-subfolder": "skills/deploy",
          },
        },
        spec: {
          title: "Deploy Helper",
          description: "Ships the service and rolls back when the smoke test fails.",
          source: {
            repository: {
              url: "https://github.com/executor-e2e/skills",
              branch: "main",
              commit: "0123456789abcdef0123456789abcdef01234567",
              subfolder: "skills/deploy",
            },
          },
        },
      }),
    }).then(() => undefined),
  ).pipe(Effect.ignore);

const removeSkill = (name: string): Effect.Effect<void> =>
  Effect.promise(() =>
    fetch(new URL(`/v0/skills/${encodeURIComponent(name)}/latest`, agentRegistryUrl), {
      method: "DELETE",
    }).then(() => undefined),
  ).pipe(Effect.ignore);

scenario(
  "AgentRegistry · a git-sourced Skill shows its provenance and quick add rejects a bad URL",
  { timeout: 180_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const identity = yield* target.newIdentity();
    const name = `executor-e2e-skill-${randomBytes(5).toString("hex")}`;

    yield* applySkill(name);

    yield* Effect.gen(function* () {
      yield* browser.session(identity, async ({ page, step }) => {
        await step("Open the Skills catalog", async () => {
          await page.goto("/plugins/agentregistry/", { waitUntil: "domcontentloaded" });
          await page.getByRole("heading", { name: "AgentRegistry" }).waitFor();
          await page.getByRole("button", { name: "Skills", exact: true }).click();
          await page.getByPlaceholder("Search skills…").fill(name);
        });

        await step(
          "See the skill's author, description, and pinned commit in the list",
          async () => {
            const row = page.getByRole("button", { name: "Deploy Helper", exact: false });
            await row.waitFor();
            await row.getByText("Ships the service and rolls back").waitFor();
            await row.getByText("by e2e-author").waitFor();
            await row.getByText("0123456").waitFor();
          },
        );

        await step("Open it and read the source panel instead of raw JSON", async () => {
          await page.getByRole("button", { name: "Deploy Helper", exact: false }).click();
          await page.getByRole("heading", { name }).waitFor();
          await page.getByText("https://github.com/executor-e2e/skills/skills/deploy").waitFor();
          await page.getByText("e2e-author", { exact: true }).waitFor();
          await page.getByRole("button", { name: "Check for updates" }).waitFor();
          // The manifest is still reachable, just no longer the whole panel.
          await page.getByText("Raw manifest").waitFor();
        });

        await step("Quick add explains a URL it cannot use", async () => {
          await page.getByRole("button", { name: "Quick add from GitHub" }).click();
          await page.getByLabel("GitHub URL").fill("https://gitlab.com/owner/repo");
          await page.getByRole("button", { name: "Find skills" }).click();
          await page.getByText("Only github.com repositories are supported.").waitFor();
        });

        await step("Quick add is offered only for git-sourced kinds", async () => {
          await page.getByRole("button", { name: "Prompts", exact: true }).click();
          await page
            .getByRole("button", { name: "Quick add from GitHub" })
            .waitFor({ state: "detached" });
        });
      });
    }).pipe(Effect.ensuring(removeSkill(name)));
  }),
);
