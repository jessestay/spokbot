# US-FW-021 — The standalone runtime starts clean or fails loud

**Story:** As a Spokbot operator, I want the standalone engine's
entry point to load without side effects, refuse to start without a
Slack token (non-zero exit, clear message), and — when the Hatchet
path is enabled — route startup through Hatchet with exactly one
immediate tick that still respects the single-instance lock, so
that the process the supervisors watch is either genuinely running
the engine or visibly not started at all.

**Difficulty:** 3 points.

**Tests:** `tests/runStandalone.test.js`, `tests/runStandaloneHatchet.test.js`, and `tests/hatchet.test.js` (jest, slack-agents root suites).

**Background:** F12 step C (story-linking). The entry surface:
`runStandalone.main` (precondition checks, side-effect-free module
load), its Hatchet branch (client creation, one immediate tick,
lock-held means skip the tick), and the Hatchet client wrapper
itself (engine-tick name constants, the default cron, init failures
propagated rather than swallowed). Criteria are derived from the
suites' assertions; no suite was rewritten.

**Acceptance criteria:**

1. Given the standalone module, When it is required, Then it
   exports main and produces no side effects.
2. Given no Slack token available, When main runs, Then it exits
   non-zero with a clear message — and on the Hatchet path, no
   Hatchet client is ever created.
3. Given HATCHET_ENABLED=1 and the lock free, When startup runs,
   Then it routes through Hatchet, initializes the work engine's
   Slack client, and performs exactly one immediate tick; given
   the lock held elsewhere, Then the immediate tick is skipped.
4. Given the Hatchet client fails to initialize, When creation is
   attempted, Then the failure propagates — it is never swallowed
   into a silently degraded start.
