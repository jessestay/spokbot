# US-FW-018 — Vikunja stays alive under watchdog supervision

**Story:** As a Spokbot operator, I want Vikunja supervised by a
watchdog that restarts it with setsid and never kills itself, so
that the team's board survives session teardown and never dies
silently.

**Difficulty:** 3 points.

**Tests:** `engine/tests/vikunja-supervision.test.js` (jest). BDD: `engine/vikunja-supervision.feature` — referenced from this story's fixture-registry entry (US-FW-018), which is how the linkage lint links feature files.

**Background:** F12 step C (story-linking). One of the 3 orphaned
feature files the plan ordered linked or retired; it is linked —
the behavior it describes is real and load-bearing. Root cause
recorded in the feature itself (Oct 10, 2026): Vikunja died
silently three times because start.sh used `nohup ... &`, and the
runtime kills the whole process group on session teardown. The fix
is setsid; the suite pins the script-level invariants (start.sh
exists and is executable, launches with setsid, never relies on
bare nohup, detaches stdin from /dev/null, and is idempotent —
probe-first, exit 0 when already up), and the feature carries the
behavioral scenarios (detect → anchored pkill → relaunch →
responding within 10 seconds; the watchdog's pkill pattern is
anchored with ^ so it can never match itself). The production
registry receives this story at its first post-cutover edit; until
then the fixture registry carries it. Criteria are derived from
the feature and the suite; neither was rewritten.

**Acceptance criteria:**

1. Given Vikunja is not responding on 127.0.0.1:3456, When the
   watchdog runs its liveness probe, Then it detects the failure,
   kills any stale Vikunja process with an anchored pkill, and
   relaunches it via start.sh so it responds within 10 seconds.
2. Given Vikunja was started by start.sh, When the parent exec
   session terminates, Then Vikunja continues running and still
   responds on 127.0.0.1:3456 (the setsid invariant).
3. Given Vikunja is responding, When the watchdog probes, Then it
   does not kill or restart it, and start.sh exits 0 immediately
   (idempotent, probe-first).
4. Given the watchdog executes the restart sequence, When it runs
   pkill, Then the pattern is anchored with ^ and the watchdog's
   own process is not matched.
