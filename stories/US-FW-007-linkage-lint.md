# US-FW-007 — A linkage lint maps every test and feature file to a story

**Story:** As a Spokbot operator verifying Scrum discipline (F12), I
want a linkage lint that cross-checks the story registry's BDD/TDD
references against the test and feature files actually present in
the tree — so that unreferenced suites, orphaned feature files, and
dangling references are measured exactly and cannot regrow silently
after the backfill.

**Difficulty:** 3 points.

**Tests:** `tests/linkageLint.test.mjs` and `tests/fixtureRegistry.test.mjs` (node:test, dependency-free).

**Background:** The F12 backfill plan (step C) found only 15 of 145
test files referenced by any story and 3 feature files referenced by
none (`autonomous-schedule.feature`, `pm-breakdown.feature`,
`vikunja-supervision.feature`). The suites are real; what is missing
is traceability. The plan prescribes a linkage lint (3 pts) that
maps every test/feature file to at least one story reference and
fails on unlinked files, run alongside the registry lint. This story
builds that tool — `slack-agents/engine/linkageLint.js`, a sibling
of `storyLint.js` — and runs it against the framework tree with the
framework fixture registry (the production registry copy carrying
the step-B references and the US-112/US-113 criteria fixes). The
tool's job is measurement: on today's tree it must report the
step-C backlog exactly (the unlinked-file inventory is the
authorship program's work list), not pronounce it green. A test
file counts as linked when a story references it, when a feature
file's "(Acceptance suite: …)" line names it, or when a framework
story document names it; a feature file counts as linked when a
story references it. Test files living outside jest's testMatch
(the two engine-root suites) are classified distinctly so the
runner gap stays visible.

**Acceptance criteria:**

1. Given a registry whose stories reference a feature and a suite,
   and a tree containing exactly those files, When the linkage lint
   runs, Then both files are reported linked (with their linking
   sources named), there are no errors, and the exit code is 0.
2. Given a tree containing a feature file no story references and a
   test file nothing references, When the linkage lint runs, Then
   it exits 1 and reports an `unlinked-feature-file` error and an
   `unlinked-test-file` error naming each file.
3. Given a registry reference to a file that does not exist, When
   the linkage lint runs, Then it exits 1 with a
   `dangling-reference` error naming the story and the path.
4. Given a test file named by a feature's "(Acceptance suite: …)"
   line or by a framework story document, When the linkage lint
   runs, Then the file is reported linked via that source even when
   no registry story references it directly.
5. Given the framework tree and the fixture registry, When the
   linkage lint runs, Then every step-B suite and feature is
   linked, the 2 engine-root test files are classified as outside
   jest's testMatch, and linked + unlinked exactly equal the total
   test files present.
   **Amended 2026-11-18 (step C completion):** as written, this
   criterion pinned the pre-authorship measurement (158 test files,
   the 3 orphaned features unlinked, an unlinked backlog over 100).
   The step-C authorship program (US-FW-008…US-FW-031) has now
   linked every file: the lint measures 158/158 test files and
   24/24 feature files linked, 0 unlinked, 0 dangling. The AC5 test
   now pins that completed state, so any future unlinked file fails
   loudly — the anti-regrowth property this story exists for. The
   original wording is preserved in git history (commit 6ec2fa3).
