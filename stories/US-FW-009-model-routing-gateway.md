# US-FW-009 — Model routing degrades gracefully: paid first, local last, never silent

**Story:** As a Spokbot operator, I want every model call routed
through a declared fallback chain — paid capability first, free and
local legs last, circuit breakers skipping dead legs — so that the
system stays LLM-agnostic and local-first-capable without ever
silently assigning work to a route that cannot do it, and so that a
gateway failure surfaces as a classified health state, not a hang.

**Difficulty:** 5 points.

**Tests:** `engine/tests/modelRouter.test.js`, `engine/tests/kernel-p1-chain.test.js`, `engine/tests/litellm-fallback.test.js`, `engine/tests/kernel-breaker-litellm.test.js`, `engine/tests/kernel-p1-litellm-route.test.js`, `engine/tests/kernel-resilience-litellm.test.js`, and `engine/tests/llm-canary.test.js` (jest); plus `tests/gatewayConfig.test.mjs` (framework node:test, Step D: the gateway/ artifacts themselves — litellm_config.yaml parses, carries no literal secrets, its fallback chain is referentially intact with the documented budget-first edges, the local-only groups stay local, and local-canary.sh probes only defined groups with its key sourced from gateway.env; 8 tests. A live routing smoke against a running gateway remains deployment-side: LiteLLM and the model backends are not part of a framework tree).

**Background:** F12 step C (story-linking). Spokbot's LLM-agnostic
claim lives here: `models.yaml` declares per-tier chains (the smart
chain is [paid, deepseek-direct, free, macf-local] — local LAST, so
local-first is a floor, not a ceiling), the LiteLLM gateway executes
the chain, per-leg circuit breakers skip tripped legs with zero
wasted calls, routes are stamped on every answer, and the canary
classifies stack health (HEALTHY / GATEWAY_DOWN / TOTAL_DOWN /
DEGRADED) so a dead gateway is a named state. Criteria are derived
from the suites' assertions; no suite was rewritten.

**Acceptance criteria:**

1. Given the smart tier's declared chain, When a call is routed,
   Then the paid gateway alias is primary, free fallback comes after
   it, and the local leg is last — and every model in the chain
   carries cost info for budget tracking.
2. Given a leg returns empty or a transport error, When the chain
   executes, Then it rotates to the next leg immediately; given all
   legs fail, Then it throws an error naming the chain rather than
   returning silence.
3. Given a leg's breaker is tripped, When a call is routed, Then
   that leg is skipped entirely (zero gateway calls when all legs
   are tripped, with a circuit-open error); given a success on a
   streaking leg, Then its breaker streak resets.
4. Given a tool-requiring delegation, When the capable route sits
   in a stale half-open claim, Then the delegation is NOT assigned
   to the local leg that cannot run its tools (the Nov 2, 2026
   regression).
5. Given the canary probes the stack, When the gateway is down but
   a direct leg answers, Then the state is GATEWAY_DOWN with the
   gap filed once; given the stack answers slower than threshold,
   Then the state is DEGRADED, not HEALTHY.
