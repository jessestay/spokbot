# US-FW-016 — Granted MCP servers connect end to end, and only for the roles that hold them

**Story:** As a Spokbot operator, I want every MCP server in the
grants file proven connectable end to end — defined in grants,
granted to at least one role, its binary present and executable,
and a live connect + tool-list handshake — so that an agent's
granted capabilities are measured facts about the running system,
not entries in a config file nobody has exercised.

**Difficulty:** 5 points.

**Tests:** `engine/tests/mcp/buffer.connectivity.test.js`, `engine/tests/mcp/canva.connectivity.test.js`, `engine/tests/mcp/figma.connectivity.test.js`, `engine/tests/mcp/google-workspace.connectivity.test.js`, `engine/tests/mcp/n8n.connectivity.test.js`, `engine/mcpClient.test.js` (jest; the last is an engine-root suite outside jest's testMatch — a known runner gap the linkage lint keeps visible), and `engine/tests/hands-servers.test.js` (jest, Step D: the first-party hands/ servers — desktop-agent, finance-files, macf-finance, the slack launcher, and both paths.js resolvers — spawned and driven over real stdio JSON-RPC: role gates refuse with exit 2, tools/list shapes are exact, and the no-credential paths error honestly; 23 tests), and `tests/xMcpProbe.test.mjs` (framework node:test, Step D: the first-party x-mcp server spawned from its built dist — startup refuses naming the first missing credential in construction order, tools/list is exactly the 19 registered tools, and the two purely local tool validations error without reaching the X API; 6 tests).

**Background:** F12 step C (story-linking). The connectivity suites
are the capability audit's ground truth (US-116 consumes their
verdicts): each asserts the server is defined in grants.json, is
granted to at least one role, and connects and lists tools end to
end; the google-workspace suite additionally pins the proxied
binary's presence and the credential store's secure permissions,
and the n8n suite the configured binary's existence. The desktop
servers' connectivity suites are linked from US-FW-019 (desktop
integration) by subject. Criteria are derived from the suites'
assertions; no suite was rewritten.

**Acceptance criteria:**

1. Given a server named in the connectivity suite, When grants are
   read, Then the server is defined in grants.json and granted to
   at least one role.
2. Given a granted server, When the MCP client connects, Then the
   handshake completes and the server lists its tools end to end.
3. Given the google-workspace server, When its setup is checked,
   Then the proxied binary exists and is executable and the stored
   credentials carry secure file permissions.
