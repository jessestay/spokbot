# US-FW-006 — The registry lint flags stories whose lifecycle never advanced

**Story:** As a Spokbot operator verifying Scrum discipline (F12),
I want the story-registry lint to flag stories that sit at
`in-progress` despite carrying complete, resolving BDD+TDD evidence —
so that "done" stays distinguishable from "started" in the F12
evidence of record, and lifecycle review debt is measured exactly
instead of inferred from a registry where every story reads the
same.

**Difficulty:** 3 points.

**Tests:** `tests/storyLintLifecycle.test.mjs` (node:test, dependency-free).

**Background:** The F12 backfill plan (step A.3, second half) pairs
the writer guard (landed as US-FW-004) with a status-lifecycle rule:
a story may move to `done` only when its referenced suites pass. The
production baseline registry shows why the rule matters — all 23
stories sit at `in-progress`, including the 12 whose BDD+TDD
references are complete and resolve, so the lifecycle carries no
information. The lint cannot run the referenced suites (that is the
verification run's job), so it must not declare any story done; what
it can do deterministically is flag the review debt: an
`in-progress` story whose evidence is complete has nothing left but
the lifecycle decision, and that flag — the `stale-in-progress`
warning, with exact summary counts — is what this story adds to
`slack-agents/engine/storyLint.js`. Warnings never change the lint's
exit code: errors stay format/reference defects, warnings stay
measured gaps, now including lifecycle gaps. The rule deliberately
does not double-flag stories whose blocker is coverage (no BDD or
no TDD references) or broken references (dangling) — those already
carry their own warnings/errors.

**Acceptance criteria:**

1. Given a story at status `in-progress` whose BDD and TDD
   references are both present and all resolve to real files, When
   the lint runs, Then the story carries a `stale-in-progress`
   warning naming it as lifecycle review debt, and the summary's
   `stale_in_progress` count includes it.
2. Given a story at `in-progress` with missing BDD or TDD coverage,
   or with a dangling reference, When the lint runs, Then it is NOT
   flagged `stale-in-progress` — its blocker is the coverage or
   reference defect it already reports, never two flags for one
   story.
3. Given a story at any other status (for example `done`), When the
   lint runs, Then it is never flagged `stale-in-progress`, whatever
   its coverage.
4. Given any registry, When the lint runs, Then the summary also
   reports `by_status` counts for every status present, and all
   pre-existing summary fields and exit-code behavior are unchanged.
5. Given the production baseline registry (23 stories, all
   `in-progress`: 12 with BDD+TDD, US-115 TDD-only, 10 with
   neither), When the lint runs against it, Then `stale_in_progress`
   is exactly 12 and `by_status` is exactly `{ "in-progress": 23 }`.
