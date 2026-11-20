# US-FW-025 — The autonomous driver is verifiably scheduled, not just written

**Story:** As a Spokbot operator, I want the autonomous driver
verifiably scheduled, so that a working driver script with no
schedule is detected as a critical defect instead of agents going
silent.

**Difficulty:** 3 points.

**Tests:** `engine/tests/autonomous-agent.test.js` and `engine/tests/schedule-manifest.test.js` (jest). BDD: `engine/autonomous-schedule.feature` — referenced from this story's fixture-registry entry (US-FW-025), which is how the linkage lint links feature files.

**Background:** F12 step C (story-linking). One of the 3 orphaned
feature files the plan ordered linked or retired; it is linked.
Root cause recorded in the feature itself (Oct 9, 2026):
autonomousRunner.js existed and worked, but no cron job ran it, so
agents went silent for hours — the unit tests verified agents
expose runAutonomous() but never verified the driver is SCHEDULED.
The manifest suite pins the declaration (the manifest is valid
JSON, autonomous-agent-driver is declared, every required schedule
carries id/cadence/command/owner/purpose, no duplicate ids), the
agent suite pins the interface (every agent exposes
runAutonomous(); the CFO's run generates its dashboard artifact),
and the feature carries the runtime scenarios (check-schedules
reports a missing driver as MISSING + CRITICAL with exit 1, and OK
with exit 0 when present; install-schedules reports what is needed
to recreate it). The production registry receives this story at
its first post-cutover edit; until then the fixture registry
carries it. Criteria are derived from the feature and the suites;
none was rewritten.

**Acceptance criteria:**

1. Given the schedules manifest, When it is validated, Then
   autonomous-agent-driver is declared with id, cadence, command,
   owner, and purpose, and no schedule id is duplicated.
2. Given the driver script exists but the autonomous-agent-driver
   schedule is absent from the runtime, When check-schedules runs,
   Then it reports the driver MISSING and CRITICAL and exits 1;
   given the schedule present, Then it reports OK and exits 0.
3. Given every agent in the roster, When the autonomous interface
   is checked, Then each agent exposes runAutonomous() and the
   CFO's run produces its dashboard artifact.
