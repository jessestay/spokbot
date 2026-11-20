# US-FW-004 — The registry read path can never silently misread a story's test lists

**Story:** As a Spokbot operator relying on F12 verdicts, I want the
story registry's read path to be proof against the stringified-list
misread — stringified values repaired back to arrays on read, and
rejected on write — so that no consumer of `userStories.js` can ever
count a string's characters as a story's test references or report a
covered story as uncovered.

**Difficulty:** 5 points.

**Tests:** `tests/userStoriesRegistry.test.mjs` (node:test, dependency-free).

**Background — root cause, established by inspection 2026-11-18:**
Every programmatic reader of the registry in the tree parses it
correctly: `userStories.loadStories()` (consumed by
`releasePlanning.js` and `scrumEnhancements.js`) and the direct
`JSON.parse` read in `engine/tests/job-submission-acceptance.test.js`
both receive real JSON arrays, because the stored fields ARE real
arrays. The two famous wrong readings were not code defects in those
readers: the Phase 1 Step 1 inventory read the registry through a
text rendering and reported the fields as "stored as stringified
lists," and the Nov 5–6 verification runs generalized "US-110..US-123
all have empty bdd_tests/tdd_tests" from a mostly-empty block (wrong
for US-111, US-112, US-115, US-118). Both errors are what happens when
a 23-story JSON file is read as prose: a flattened array
(`"[\"engine/tests/receipts.test.js\"]"`) is indistinguishable from
stringified storage, and a range summary is indistinguishable from a
per-story count. US-FW-003's lint removes the prose reading; this
story removes the residual code hazard the inventory imagined:

- `loadStories()` returns the three list fields exactly as stored.
  If a writer ever stores a stringified list, every array-expecting
  consumer misreads silently and inconsistently: a length check sees
  the string's character count (non-zero — "covered"), an
  `Array.isArray` check sees a non-array ("empty"), and `.filter` /
  `.map` throw. Two checks of the same story disagree — the exact
  signature of the historical misreadings.
- `createStory()` performs no type validation on the list fields, so
  the stringified write that would trigger the above is accepted
  today without a murmur.

**Fix (framework copy only):** `userStories.js` gains
`normalizeStoryFields` (on read: a string that parses as a JSON array
of strings is parsed back to an array; a non-parseable string is left
untouched so the lint can flag it as evidence, never silently
rewritten) applied inside `loadStories()`, and `assertArrayFields`
(on write: `createStory` and `saveStories` throw a TypeError when any
of `acceptance_criteria`, `bdd_tests`, `tdd_tests` is present and not
an array of strings). This is the writer-guard half of F12 backfill
step A.3; the status-lifecycle rule ("done only when referenced
suites pass") remains a separate follow-up.

**Acceptance criteria:**

1. Given a story whose `bdd_tests` is the string
   `"[\"engine/tests/receipts.test.js\"]"` (a stringified list, as a
   defective writer would store it), When the story passes through
   the read path (`normalizeStoryFields`, as applied by
   `loadStories`), Then `bdd_tests` is the array
   `["engine/tests/receipts.test.js"]` — `Array.isArray` true, length
   equal to the element count (1), not the string's character count.
2. Given a story whose list fields are already arrays, When it passes
   through the read path, Then the fields come back unchanged
   (normalization is idempotent and lossless).
3. Given a string that is not a JSON array (e.g. `"engine/tests/x.js"`
   or `"not json"`), When it passes through the read path, Then it is
   left exactly as stored — repair never invents or discards data;
   the US-FW-003 lint remains the component that flags it.
4. Given `createStory` is called with a stringified (string-typed)
   `bdd_tests`, `tdd_tests`, or `acceptance_criteria`, When the call
   is made, Then it throws a TypeError naming the field, and no
   registry file is created or modified by the rejected call.
5. Given `saveStories` is handed data containing a story with a
   string-typed list field, When it is called, Then it throws before
   writing anything.
6. Given the production baseline registry, When every story is passed
   through the read-path normalization, Then the coverage distribution
   is unchanged (12 BDD+TDD, 1 TDD-only, 10 neither) and every list
   field of every story is an array — the fix provably does not
   perturb healthy data.
