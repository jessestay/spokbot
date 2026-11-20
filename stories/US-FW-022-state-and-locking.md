# US-FW-022 — One writer at a time, and no agent reads another's memory

**Story:** As a Spokbot operator, I want the kernel's shared state
disciplined by a lock with heartbeat semantics — acquire when free
or stale, refresh when re-entrant, stand down when a fresh peer
holds it — and per-agent memory namespaces that cannot leak into
each other, so that two engine processes never work the same board
at once and no specialist ever sees another agent's private state.

**Difficulty:** 3 points.

**Tests:** `tests/state.test.js`, `tests/lock.test.js`, and `tests/workEngineLock.test.js` (jest, slack-agents root suites).

**Background:** F12 step C (story-linking). The state layer: the
Vikunja-backed lock task (create-and-acquire, stale takeover with a
fresh heartbeat, re-entrant refresh, stand-down that writes
nothing), the work engine's runCycle integration with that lock
(acquire first; stand down untouched when refused; never work the
lock task itself; a board holding only the lock task works
nothing), and per-agent memory isolation (separate namespaces and
files, capped push). Criteria are derived from the suites'
assertions; no suite was rewritten.

**Acceptance criteria:**

1. Given no lock task exists, When a cycle acquires, Then it
   creates the lock and proceeds; given a fresh lock held by
   someone else, Then it stands down and writes nothing; given its
   own lock, Then it refreshes re-entrantly; given a stale foreign
   lock, Then it takes over with a fresh heartbeat.
2. Given a board containing only the lock task, When a cycle runs
   with the lock acquired, Then nothing is worked — the lock task
   is never treated as work.
3. Given two agents' memory namespaces, When one agent reads and
   writes, Then the other's memory is never exposed, each writes
   to its own file, and push caps the array at its maximum length.
