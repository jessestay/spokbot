# US-FW-019 — Desktop health is classified, never guessed

**Story:** As a Spokbot operator, I want the desktop integration's
health read as a classified state — HEALTHY, TUNNEL_REFUSE_ALL,
DESKTOP_DOWN, or DESKTOP_DEGRADED — derived from the tunnel probe
and the desktop's own response, with the tunnel proxy derived
robustly from the environment, so that when the operator's desktop
is unreachable the team knows which layer failed instead of
blaming the wrong machine.

**Difficulty:** 3 points.

**Tests:** `engine/tests/desktop-health.test.js`, `engine/tests/desktop-probe.test.js`, `engine/tests/mcp/desktop-agent.connectivity.test.js`, and `engine/tests/mcp/desktop-commander.connectivity.test.js` (jest).

**Background:** F12 step C (story-linking). The desktop is the
operator's machine on a Wi-Fi-only path behind the Tailscale tunnel
proxy; its failure modes are layered (tunnel refusing all
connections vs desktop down vs one path degraded), and the runbook
history shows each layer being blamed for another's failure. The
classifier and the proxy derivation (host:3130 forced, credentials
tolerated, whitespace tolerated) are the framework half; the two
connectivity suites prove the desktop MCP servers (desktop-agent,
granted to the CTO; desktop-commander) are defined, granted, and
connect end to end. Criteria are derived from the suites'
assertions; no suite was rewritten.

**Acceptance criteria:**

1. Given the tunnel probe and the desktop both respond, When
   health is classified, Then it is HEALTHY; given the probe says
   REFUSE-ALL, Then it is TUNNEL_REFUSE_ALL; given a healthy tunnel
   but an unreachable desktop, Then DESKTOP_DOWN; given only one
   path working, Then DESKTOP_DEGRADED.
2. Given a proxy URL with credentials, extra whitespace, or a
   non-3130 port, When the tunnel proxy is derived, Then the
   result is the proxy host on port 3130.
3. Given the desktop MCP servers, When grants are read, Then
   desktop-agent is defined and granted to the CTO and
   desktop-commander is defined and granted, and both connect and
   list tools end to end.
