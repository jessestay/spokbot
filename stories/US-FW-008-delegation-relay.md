# US-FW-008 — Delegation headers route work to the named agent

**Story:** As a Spokbot operator running a multi-agent chief-of-staff
system, I want a directive written as `[from: X → Agent]` in Slack to
reach exactly the agent it names — so that the executive agent can
hand work to specialists (CMO, CCO, Lawyer, Job Coach, and the rest
of the roster) and trust that the handoff, not the prose around it,
decides who acts.

**Difficulty:** 3 points.

**Tests:** `tests/delegation.test.js` and `tests/delegation-relay.test.js` (jest, slack-agents root suites).

**Background:** F12 step C (story-linking). The delegation pattern is
the kernel's routing contract: `delegation.js` pattern-matches the
header (including multi-word agent names and hyphen/space variants)
and the relay dispatches the directive to the resolved agent's
handler. These two suites predate the story; this story's criteria
are derived from what they actually assert, per the backfill plan —
no suite was rewritten. Both suites live at the slack-agents root
(`tests/`), inside jest's testMatch.

**Acceptance criteria:**

1. Given a message carrying the header `[from: X → CMO]`, When the
   delegation pattern routes it, Then it resolves to the cmo agent —
   and likewise for CCO, Job Coach, CUXO, CRO, and Lawyer headers.
2. Given a relay dispatch for a named target (including Exec PM),
   When the relay runs, Then the named agent's handler receives the
   directive.
3. Given a message with no delegation pattern, When routing runs,
   Then nothing is dispatched — silence, not a guess.
