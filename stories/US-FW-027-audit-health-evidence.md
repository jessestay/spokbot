# US-FW-027 — Audit and health evidence surfaces report only what they can prove

**Story:** As a Spokbot operator, I want the evidence surfaces the
verification functions read — the capability baseline, the CFO
dashboard mechanism, honest demo detection, standup blocker
rendering, token health, and tool-usage error classification — to
report only what their inputs prove, so that a green reading means
the capability, the demo, or the credential is real, and a gap is
never rendered as a blocker after it has closed.

**Difficulty:** 5 points.

**Tests:** `engine/tests/capability-baseline.test.js`, `engine/tests/cfo-dashboard.test.js`, `engine/tests/sprintDemo.test.js`, `engine/tests/sprintDemo-honest.test.js`, `engine/tests/standupBlockers.test.js`, `engine/tests/token-health.test.js`, and `engine/tests/toolUsageAuditor.test.js` (jest).

**Background:** F12 step C (story-linking). The F7/F9/F10-adjacent
evidence layer around US-115/US-116/US-119: the capability
baseline (the required out-of-the-box server set is covered by
defaults, no gated server leaks into the baseline, every baseline
server is defined in grants, and the tool-call budget floor is at
least 24 for every agent — Jesse's story-#906 capability rule);
the CFO dashboard mechanism (an hourly trigger exists, generation
degrades gracefully without PayPal, the artifact lands at a stable
location); demo detection in both its forms (project coverage
across both boards, and the honest form — only a recent work-engine
deliverable counts as demoed, heartbeat activity does not, and a
stale lastDemo does not); standup blockers (closed gaps do not
render, legacy gaps fail open, a gap superseded by a later demo is
skipped); token health (a missing token store reads unknown, never
ok; expiry without a refresh token warns or demands re-auth by
distance); and the tool-usage auditor's error classification
(permission and not-found are fixable; sandbox traversal is an
agent error; bad URLs are input errors). **Known defect, recorded
not hidden: `capability-baseline.test.js` currently fails to LOAD
in the framework tree (suite-level, 0 tests run) — proven
pre-existing in the US-116 session by stash comparison; the story
links it so the defect stays measured, and fixing the load failure
is its own follow-up, not a precondition for linkage.** Criteria
are derived from the suites' assertions; no suite was rewritten.

**Step D update (2026-11-19): the load failure is FIXED.** Cause:
the suite hard-read `hands/grants.json` at module load, but the
framework tree deliberately carries no live grants (US-FW-001
AC6) — Step 3 parameterization shipped `hands/grants.example.json`
instead, and the suite was never updated. Fix, in the working
copy: `utils/mcpTools.loadGrants` now resolves live grants first
and falls back to the shipped example (the tree's instance-first /
framework-default doctrine; deployed trees unaffected, neither
file still fails soft to no grants), and the suite resolves the
same way instead of hard-reading the instance file. Verified:
the suite loads and passes 19/19 in the framework tree, and the
neighboring mcpTools consumers (kernel-p2-mcp, us-116) still
pass 10/10. One semantic change for CEO review: a deployed tree
whose grants.json goes missing now reads the shipped example
baseline instead of no grants at all.

**Acceptance criteria:**

1. Given the grants defaults, When the capability baseline is
   evaluated, Then the required out-of-the-box servers are all
   covered, no gated server appears in the baseline, every
   baseline server is defined in grants, and every agent's
   tool-call budget floor is at least 24.
2. Given an agent with only heartbeat activity, When demo
   detection runs, Then the agent does NOT count as demoed; given
   a recent work-engine deliverable, Then it counts; given a
   lastDemo older than the window, Then it does not.
3. Given a standup gap that has closed or been superseded by a
   later demo, When blockers render, Then it is not rendered;
   given a legacy gap with no status field, Then it renders
   (fail-open).
4. Given a missing token store, When token health is read, Then
   the state is unknown — never ok; given an expired token with no
   refresh token, Then it demands re-auth.
5. Given a tool error, When the auditor classifies it, Then
   permission and missing-path errors are marked fixable, sandbox
   traversal is an agent error, and an invalid URL is an input
   error.
