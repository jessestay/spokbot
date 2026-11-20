# US-FW-017 — Vikunja is the team's board: configured per agent, retried on transients, gated by role

**Story:** As a Spokbot operator, I want the Vikunja integration —
the task board the whole multi-agent team plans against — to
resolve configuration and per-agent tokens correctly, retry
transient server errors without retrying client errors, expose
task tools only to granted roles, and triage ticket urgency from
the task's own words, so that the board is a reliable source of
truth rather than another thing that fails silently.

**Difficulty:** 3 points.

**Tests:** `tests/vikunja.test.js`, `engine/tests/vikunja-retry.test.js`, `engine/tests/kernel-p3-vikunja-tool.test.js`, and `engine/tests/ticket-triage.test.js` (jest).

**Background:** F12 step C (story-linking). The engine refuses to
run without Vikunja (the Step 7 compose draft encodes the same
dependency), so its client behavior is kernel-critical: config and
token resolution (per-agent token beats the shared token; no URL or
no token means not configured), updateTask's retry discipline
(fresh GET per attempt, retries on 5xx, never on 4xx, loud throw
after exhaustion), the agent-facing task tools' role gate
(fail-closed on a missing agent id), and urgency detection for
triage. The watchdog's supervision of the Vikunja process itself
is US-FW-018. Criteria are derived from the suites' assertions; no
suite was rewritten.

**Acceptance criteria:**

1. Given no URL or no token, When configuration is checked, Then
   Vikunja reports not configured; given both, Then a per-agent
   token takes precedence over the shared token.
2. Given a transient 500 from the server, When a task update runs,
   Then it retries with a fresh GET per attempt and succeeds; given
   a persistent 500, Then it throws after exhausting retries; given
   a 4xx, Then it does not retry.
3. Given an ungranted agent or a missing agent id, When a Vikunja
   task tool is invoked, Then it is refused with a permission error
   (fail closed); given a granted agent, Then the shaped task with
   recent comments is returned.
4. Given a task titled or described with an urgent keyword, an
   "asap", or a deadline, When triage evaluates it, Then it is
   flagged urgent; given none, Then it is not.
