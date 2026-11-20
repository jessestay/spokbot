# US-FW-003 — A deterministic lint is the F12 evidence of record for the story registry

**Story:** As a Spokbot operator verifying that the kernel follows
Scrum discipline (F12), I want a deterministic lint tool that parses
the story registry (`engine/.user-stories.json`) and reports, per
story, the field types, acceptance-criteria count, BDD/TDD reference
counts, dangling references, and status — so that F12 verdicts come
from a program whose output can be diffed run to run, never from a
prose reading of a JSON file through a text tool.

**Difficulty:** 3 points.

**Tests:** `tests/storyLint.test.mjs` (node:test, dependency-free).

**Background:** The production registry stores `acceptance_criteria`,
`bdd_tests`, and `tdd_tests` as proper JSON arrays (verified by direct
parse of the baseline snapshot, 2026-11-17/18: 23 stories, 12 with
BDD+TDD references, US-115 TDD-only, 10 with none, 0 dangling
references). Two readings disagreed with the file: the Phase 1 Step 1
inventory reported the fields as "stored as stringified lists," and
early verification runs generalized "US-110..US-123 all have empty
bdd_tests/tdd_tests" (wrong for US-111, US-112, US-115, US-118). Both
errors came from reading the registry through text renderings instead
of a parser. The F12 backfill plan (step A.1) prescribes this lint as
the fix: its output becomes the F12 evidence of record. The tool lives
at `slack-agents/engine/storyLint.js` (module + CLI), resolves test
references relative to the `slack-agents/` directory that contains the
registry's `engine/` directory, and is dependency-free.

**Acceptance criteria:**

1. Given a well-formed registry whose stories carry story-format
   titles ("As a … / As the … / As Jesse, I want …"), Given/When/Then
   criteria, a Fibonacci difficulty score, and BDD/TDD references that
   resolve to real files, When the lint runs, Then it exits 0 and its
   JSON report counts every story as having both BDD and TDD coverage
   with zero errors.
2. Given a registry whose `bdd_tests` (or `tdd_tests`, or
   `acceptance_criteria`) field is a stringified list instead of a
   JSON array, When the lint runs, Then it exits 1 and reports a
   `stringified-field` error naming the story and the field — the
   exact defect class that prose readings hallucinated into the
   healthy registry must be unmissable when it is real.
3. Given a registry with a reference to a file that does not exist,
   When the lint runs, Then it exits 1 and reports a
   `dangling-reference` error naming the story and the missing path.
4. Given a story with no acceptance criteria, a criterion that is not
   in Given/When/Then form, a missing or non-Fibonacci difficulty
   score, or a title that is not in story format, When the lint runs,
   Then it exits 1 and reports the specific format error per story.
5. Given a story with criteria and a difficulty score but zero BDD or
   zero TDD references, When the lint runs, Then the story is reported
   as a coverage warning (not an error): the summary counts stories
   with both, TDD-only, BDD-only, and neither, so the F12 coverage gap
   is measured exactly and cannot be overstated or understated.
6. Given the production baseline registry (23 stories) in the staging
   snapshot, When the lint runs against it, Then the summary counts
   match the verified hand count of the same file — 12 stories with
   BDD+TDD, 1 TDD-only (US-115), 10 with neither, 0 dangling
   references, 0 stringified fields — and the only errors reported
   are the two criterion-format deviations the lint measured in that
   file: US-112 and US-113 each carry a criterion written in
   compressed "Given …, Then …" form with no explicit "When" clause.
   (AC amended 2026-11-18 after the first baseline run measured those
   two criteria; the original draft of this criterion assumed zero
   errors. The deviations are real registry defects for the backfill
   list, not lint false positives.)
