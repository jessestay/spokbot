# US-FW-033 — Pre-cutover MCP spawn smoke for rewritten-path servers

**Story:** As the CEO executing a Step 5-class cutover, I want a smoke
that spawns each rewritten-path MCP server from the NEW tree exactly
as the engine and the capability audit spawn it — same command, same
args, same cwd resolution, same env shape — and verifies it answers
an MCP initialize + tools/list handshake, so that a missing
dependency in the new tree fails loudly in staging instead of
failing the W6 capability gate after the engine has restarted.

**Difficulty:** 5 points.

**Tests:** `tests/mcpSpawnSmoke.test.mjs` (node:test, dependency-free).

**Background:** The first Step 5 attempt (2026-11-18 20:53 UTC) was
rolled back at the W6 capability gate: the staged framework's
`x-mcp/` had no `node_modules`, so the x server died on spawn
(`@modelcontextprotocol/sdk`, `dotenv`, `zod`, `oauth-1.0a`
unresolvable) and the failure set came back {linkedin, x,
tiktok-research} against the {linkedin, tiktok-research} baseline.
The W6 audit was the first time anything had spawned the x server
from the new tree. The runbook's required fix (2): "Add a pre-W5
smoke: spawn each of the seven rewritten-path MCP servers from the
staged tree and confirm it answers initialize — the W6 audit should
never be the first spawn."

The seven rewritten-path servers (runbook §2.4) are:
desktop-commander, n8n-mcp, macf-finance, finance-files,
desktop-agent, slack, x. Their spawn shape is defined by two
consumers that must agree: `engine/mcpClient.js` (loads
`slack-agents/.env`, expands `${VAR}` placeholders in the grants
config from it, spawns with `{...process.env, ...config.env}`) and
`engine/capabilityAudit.js` (cwd = `spec.cwd` resolved against the
framework root, defaulting to `hands/`; env adds `MACF_ROLE=CEO`
and `MACF_ROLE_TOKEN` from `hands/.role-tokens`; 45 s probe
timeout). The smoke mirrors both.

**Acceptance criteria:**

1. Given a grants.json and a framework root, When the smoke builds
   a spawn plan for a server, Then command and args are the grants
   values verbatim, cwd is the grants `cwd` resolved against the
   framework root (default `hands/`), and env is the process env
   overlaid with the server's grants env after `${VAR}` expansion
   from `slack-agents/.env`, plus `MACF_ROLE` and `MACF_ROLE_TOKEN`
   (from `hands/.role-tokens`) when a role is requested.
2. Given a server that answers initialize and tools/list, When the
   smoke probes it, Then it reports PASS with the exact tool count.
3. Given a server whose entry dies on a missing module, When the
   smoke probes it, Then it reports FAIL with the child's stderr as
   evidence — a spawn death is never reported as a pass.
4. Given a server that starts but never answers within the timeout,
   Then the smoke reports FAIL with a timeout reason.
5. Given a role-gated server that starts (imports resolve) and then
   refuses the probe's role per its documented rule (macf-finance
   requires the CFO role; the probe carries CEO, exactly as the
   capability audit does), Then the smoke reports ROLE-REFUSAL as
   its own class — the boot is proven, the refusal is the server's
   production-identical behavior, and it is never conflated with a
   dependency failure.
6. Given `--seven` mode, When the smoke runs against a tree, Then
   it probes exactly the seven §2.4 servers and exits non-zero if
   any of them FAILs (ROLE-REFUSAL does not fail the run; it is
   printed distinctly in the summary).
