# US-FW-024 — Build-batch engine contracts: batched dispatch, honest artifacts, the sweep, and the empty-body gate

**Story:** As a Spokbot operator, I want the engine behaviors that
shipped in the CEO build batches pinned as standing contracts —
batched task dispatch in lane and priority order, artifact
classification from receipts, the contract-sweep directive text,
and the empty-body gate that rejects header-only responses — so
that those behaviors survive as kernel guarantees rather than as
the memory of the batches that introduced them.

**Difficulty:** 5 points.

**Tests:** `engine/tests/ceo-build3-batch.test.js`, `engine/tests/ceo-build4-artifacts.test.js`, `engine/tests/ceo-build5-sweep.test.js`, and `engine/tests/ceo-empty-body-gate.test.js` (jest).

**Background:** F12 step C (story-linking). The suite names are
historical — they record the build batches (3, 4, 5) that produced
the features — but every assertion pins current engine behavior:
the dispatcher path (one cycle dispatches a capped batch in lane +
priority-band order, following server-capped pagination to the
last page; the inline path stays exactly one task per cycle),
receipt-to-artifact classification with Denver-day bucketing
(US-122's demo relay consumes the same helpers), the sweep text
(every agent name resolving through the delegation targets, the
roster covered exactly once, the exact directive header and
charter contract), and the F2 empty-body gate (a header-only
response — workflow-nested or poller-shaped — is rejected as
empty_response and nothing posts; a real body finalizes; the
visible reply mirror withholds header-only bodies). Criteria are
derived from the suites' assertions; no suite was rewritten.

**Acceptance criteria:**

1. Given a board with more eligible tasks than the batch cap, When
   a dispatcher cycle runs, Then it dispatches the cap's worth in
   lane and priority-band order, top priorities first, paging to
   the last page; given the inline path, Then exactly one task
   dispatches per cycle.
2. Given an error receipt, When artifacts are classified, Then it
   produces none; given explicit artifacts, Then they pass through;
   and timestamps bucket by America/Denver day.
3. Given the sweep text is built, When it is composed, Then it
   starts with the exact directive header, carries the charter
   contract, and every roster agent name resolves to its id
   exactly once.
4. Given an agent response with a header and no body, When the
   empty-body gate evaluates it, Then it is rejected as
   empty_response and nothing is posted or mirrored; given a real
   body, Then it finalizes and posts.
