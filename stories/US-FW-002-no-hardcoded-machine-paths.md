# US-FW-002 — The kernel carries no hardcoded machine paths

**Story:** As a Spokbot operator deploying the framework on my own
machine, I want every path the kernel uses — state, sandbox, desktop
client, finance data, operator-home directories — resolved from the
environment and the checkout layout (through `utils/instancePaths.js`
or the operator-home anchor), so that the framework runs unchanged on
any operator's machine and never silently reads or writes another
user's tree.

**Difficulty:** 13 points.

**Background:** Step 3 (US-FW-001) introduced `instancePaths` and wired
four call sites. A follow-up scan found the remaining hardcoded
machine paths: five separate copies of the state-dir resolution with
the literal `/home/hatch/workspace/macf/slack-agents/.state` baked in
(`utils/state.js`, `engine/receipts.js`, `utils/checkpointAdapters.js`,
`utils/circuitBreaker.js`, `engine/artifactLedger.js`,
`engine/toolUsageAuditor.js`), the tool auditor's per-user sandbox /
fixable-root literal lists, the desktop-run client literal in
`utils/agentTools.js` and `hands/servers/desktop/index.js`, the
tunnel-probe literal in `engine/desktop-probe.js`, the finance dir
literal in `hands/servers/finance-files/index.js`, `/home/hatch`
fallbacks in `engine/check-schedules.js` and
`engine/mcp-token-refresher.js`, a hardcoded SDK require in
`hatchet-smoke.js`, hardcoded env/log paths in
`gateway/local-canary.sh`, and per-machine literals in the
google-workspace connectivity and vikunja-supervision tests.

**Acceptance criteria:**

1. Given the swept files (the 14 code files and 2 test files named in
   the background, plus the kernel-p3 fixture), When they are scanned
   for per-machine absolute path literals (`/home/hatch`,
   `/home/ubuntu`, `/home/macf`, `/home/sandbox`, `C:\Users\…`),
   Then none remain — in code or in comments that present the literal
   as a current path.
2. Given the state-dir consumers (`utils/state.js`,
   `engine/receipts.js`, `utils/checkpointAdapters.js`,
   `utils/circuitBreaker.js`, `engine/artifactLedger.js`,
   `engine/toolUsageAuditor.js`), When each resolves its state
   directory under the same environment, Then all six agree on one
   directory: `RAILWAY_VOLUME_MOUNT_PATH` wins over `MACF_STATE_DIR`,
   which wins over `SPOKBOT_STATE_DIR`, which wins over the checkout
   default `<slack-agents>/.state` — the resolution lives in exactly
   one place (`instancePaths.resolvedStateDir()`).
3. Given an arbitrary operator `HOME`, When `utils/agentTools.js`
   resolves the agent sandbox and the desktop-run client, Then both
   sit under that `HOME` (`workspace/agent-sandbox`,
   `workspace/desktop-agent/bin/desktop-run`); Given
   `DESKTOP_RUN_CLIENT` is set, Then it wins. The same resolution
   holds for the desktop hands server, and `engine/desktop-probe.js`
   resolves the tunnel probe as `$HOME/bin/tunnel-probe.py` unless
   `TUNNEL_PROBE_PATH` is set.
4. Given `SPOKBOT_FINANCE_DIR` is set, When the finance-files hands
   server resolves its data directory, Then it uses that value; Given
   it is unset, Then the directory is
   `$HOME/workspace/agent-sandbox/finance` — the engine-HOME layout
   production uses today, with no machine literal.
5. Given the tool usage auditor, When it builds its sandbox candidates
   and fixable roots, Then they are anchored to the running user's
   home sandbox, the instance tree's sandbox, the state dir and the
   checkout — never to another user's home — and extra roots can be
   added via `MACF_EXTRA_FIXABLE_ROOTS`.
6. Given an arbitrary operator `HOME`, When `engine/check-schedules.js`
   looks for cron definition mirrors and `engine/mcp-token-refresher.js`
   looks for its auth directory, Then both resolve under that `HOME`
   (via `os.homedir()`), with no literal fallback user.
7. Given the google-workspace connectivity test and the
   vikunja-supervision test, When they resolve the paths they probe,
   Then the machine anchor comes from `os.homedir()` /
   `MACF_ROOT` / env override — no per-machine literals.
8. Given the pre-existing framework test suites for every touched
   module, When they are run after the sweep, Then they pass with at
   least their pre-sweep counts (baseline: 16 suites / 163 tests),
   and the US-FW-001 suite still passes 7/7.

**Tests:** `tests/hardcodedPaths.test.mjs` (node:test,
dependency-free; run `node --test tests/`). Each test names the
criterion it proves. The hands-server path resolvers live in
dependency-free `paths.js` modules beside each server so they are
testable without the MCP SDK installed.
