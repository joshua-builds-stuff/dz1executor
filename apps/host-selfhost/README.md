# Self-hosted Executor

The self-hostable Executor stack: the typed API, MCP server, Better Auth,
QuickJS execution, native web UI, and an integrated AgentRegistry control plane.
Executor retains its libSQL catalog and policy model; AgentRegistry uses its own
PostgreSQL catalog for agents, MCP servers, skills, prompts, models, plugins,
runtimes, and deployments.

## Run it

Using the published image:

```bash
docker run -d \
  --name executor-selfhost \
  -p 4788:4788 \
  -v executor-data:/data \
  -e AGENTREGISTRY_URL=https://registry.example.com \
  ghcr.io/usefulsoftwareco/executor-selfhost:latest
```

The standalone image expects an existing AgentRegistry. Use the repository's
Compose stack below when you want AgentRegistry and PostgreSQL bundled.

Or build from a repository clone:

```bash
# From this directory:
docker compose up -d --build
# open http://localhost:4788, create the admin account, then choose AgentRegistry
```

No configuration is required. Compose starts Executor, AgentRegistry, and its
database. A fresh Executor instance shows a setup screen; the first person to
create an account becomes the owner. After that, people join via
single-use invite links you mint from the **Admin** page, and self-service
signup is closed.

See [`.env.example`](./.env.example) for optional settings (most importantly
`EXECUTOR_WEB_BASE_URL` behind a domain / TLS) and the full
[Self-Hosting guide](../../docs/self-hosting/guide.mdx) for first-run, inviting
people, backups, reverse-proxy setup, and upgrades.

AgentRegistry's native UI is also available at `http://localhost:12121` and its
MCP/gateway port at `31313`. Executor talks to it over the private Compose
network and exposes its complete API through governed Executor MCP tools and the
**AgentRegistry** page. Set `AGENTREGISTRY_URL` and, when required,
`AGENTREGISTRY_TOKEN` to use an existing registry instead of the bundled one.

## Develop

```bash
bun run build                  # build the SPA (regenerates the route tree)
bun run src/serve.ts           # serve the built app
bun run --filter @executor-js/host-selfhost test   # the test suite
```

## Layout

```
src/
  app.ts            the ExecutorApp.make composition root
  serve.ts          the Bun server entry
  config.ts         env + zero-config secret/key persistence
  auth/             Better Auth wiring, the signup gate, invite codes, seed
  account/          the AccountProvider seam (members/roles via the org plugin)
  admin/            the invite-code admin HttpApi
  system/           public /api/health + /api/setup-status
  db/ · mcp/ · execution.ts · plugins.ts · observability.ts
web/                the TanStack Router SPA (setup, login, join, admin, …)
```
