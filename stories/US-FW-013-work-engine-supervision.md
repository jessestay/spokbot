# US-FW-013 — The work engine supervises itself: fair picking, strike discipline, a living process

**Story:** As a Spokbot operator, I want the work engine's internal
supervision pinned by tests — the task picker preferring contracted
work without starving the board, failures striking and parking a
task after 3 failures in 4 hours, health records syncing from real
completions, and the process's keepalive intervals staying ref'd —
so that the engine neither spins on a poisoned task nor silently
exits while its schedules believe it is alive.

**Difficulty:** 5 points.

**Tests:** `engine/tests/workEngine-health.test.js`, `engine/tests/workEngine-picker.behavior.test.js`, `engine/tests/workEngine-strikes.test.js`, `engine/tests/workEngine.roundexhaustion.behavior.test.js`, `tests/workEngine.test.js`, and `tests/engineKeepalive.test.js` (jest).

**Background:** F12 step C (story-linking). These suites cover the
work engine's internals (distinct from the US-FW-010 durable layer
and the US-FW-022 locking story): task classification (dormant,
Jesse-gated, time-critical), the picker, the failure-strike system
(the starvation fix), round-exhaustion accounting for contracted
tasks, agent health sync, and the keepalive invariant — an unref'd
interval once let the standalone process exit while supervisors
thought it alive. Criteria are derived from the suites' assertions;
no suite was rewritten.

**Acceptance criteria:**

1. Given contracted and uncontracted work on the board, When the
   picker chooses, Then it prefers the stalest contracted task;
   given no contracted work eligible, Then it still fail-closes on
   the stalest task with backoff preserved.
2. Given a task failing repeatedly, When the third failure lands
   inside 4 hours, Then the task is parked; given a success, Then
   strikes clear and the task unparks; given strikes older than 4
   hours, Then they expire.
3. Given a contracted task exhausting its rounds with banked work,
   When the cycle ends, Then no strike is recorded, no lifecycle
   attempt is burned, lastWorked advances, and the miss feeds
   forward to the next pick.
4. Given a completed directive, When health sync runs, Then the
   agent's completions increment and lastActivity is set; given a
   failed one, Then lastActivity updates without incrementing.
5. Given the standalone engine running, When its keepalive is
   configured, Then the cycle and keepalive intervals stay ref'd
   so the process cannot exit underneath its own schedules.
