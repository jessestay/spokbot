# US-FW-031 — The PM breaks CEO requirements into assigned user stories

**Story:** As the CEO of the Spokbot team, I want requirements
broken down into assigned user stories by the PM, so that a
content or visual requirement becomes platform-sized stories with
acceptance criteria on the board instead of one vague ask.

**Difficulty:** 3 points.

**Tests:** `slack-agents/engine/tests/pm-breakdown.test.js`
(jest, 39 tests) — authored in F12 Step D (2026-11-19), closing
the gap this story recorded at step C; extended in Step 6/7
(2026-11-19) with the two legs below. The suite pins behavior
read from the two modules: ceoToPm's exact ROLE_MAP (all
eight type→role routes), the structured-requirement shape and
defaults (description "", priority 3, deadline null, status
pending-pm-breakdown), both throw paths (missing type/title;
unknown type, named in the message), the delegation stub's
hand-off shape, and — against a stub HTTP server on the module's
hardcoded gateway port — pmBreakdown's prompt construction
(model muse-spark-1.3, requirement fields in the user message)
and reply parsing (clean JSON array, prose/markdown-wrapped
array, no-array rejection, malformed-JSON rejection), plus
callGateway's three rejection branches (gateway error, unexpected
shape, non-JSON body).
BDD: `engine/pm-breakdown.feature` — referenced from the
fixture-registry entry, which is how the linkage lint links
feature files.

**Step 6/7 implementation (2026-11-19) — the two legs Step D
recorded as missing are now built, TDD (13 tests RED → GREEN):**
(1) AC1's "written to Vikunja as subtasks": `writeStoriesToVikunja`
in `engine/pm-breakdown.js` creates the requirement as a parent
task and each story as a task linked by a `subtask` relation,
via a new `addTaskRelation` on the existing `utils/vikunja.js`
client (PUT /tasks/{id}/relations, the client's own patterns).
The target project comes from the caller or the
`VIKUNJA_PM_PROJECT_ID` env var; with neither, the write throws
rather than failing silently. (2) AC3's clarifying questions:
`detectGaps` flags a requirement carrying neither a description
nor explicit acceptance criteria (either alone suffices — the
AC1 scenario's description-only requirement proceeds);
`processRequirement` then posts the questions through an injected
`askCeo` channel and creates no stories, returning
`awaiting-ceo-clarification`. askCeo has no default — this module
holds no Slack client, and an unwired caller fails loudly instead
of dropping the questions; the engine-side wiring of askCeo to a
Slack-backed poster is the remaining integration step when a
caller adopts processRequirement. `processRequirement` is the
orchestration entry point (gaps → breakdown → board write, the
last only when Vikunja is configured). callGateway's 60s timeout
remains untested (longer than jest's testTimeout).

**Background:** F12 step C (story-linking). One of the 3 orphaned
feature files the plan ordered linked or retired; it is linked.
The feature's scenarios: a content requirement spanning X,
Facebook, and TikTok becomes one story per platform with
acceptance criteria, assigned to the CMO and written to Vikunja
as subtasks; a visual requirement becomes feed and stories
stories with dimensions and style, assigned to the CUXO; an
ambiguous requirement gets clarifying questions to the CEO and no
stories until he responds. The production registry receives this
story at its first post-cutover edit; until then the fixture
registry carries it. Criteria mirror the feature's scenarios;
the feature was not rewritten.

**Acceptance criteria:**

1. Given the CEO sends a content requirement via ceoToPm spanning
   X, Facebook, and TikTok, When the PM processes it, Then it
   produces one user story per platform, each with acceptance
   criteria, assigned to the CMO, written to Vikunja as subtasks.
2. Given a visual requirement, When the PM processes it, Then it
   produces feed and stories stories specifying dimensions and
   style, assigned to the CUXO.
3. Given a requirement with missing acceptance criteria, When the
   PM processes it, Then it identifies the gaps, posts clarifying
   questions to the CEO, and creates no stories until the CEO
   responds.
