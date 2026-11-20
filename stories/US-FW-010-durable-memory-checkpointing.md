# US-FW-010 — Durable execution: directives checkpoint, resume, and remember across restarts

**Story:** As a Spokbot operator, I want every directive's work to
be checkpointed as it runs — conversation, step index, tool results,
receipts — so that when a worker dies mid-task the work resumes from
its checkpoint instead of restarting or vanishing, side effects are
never repeated, stale checkpoints are pruned on a retention rule,
and facts learned in one task are recalled, scoped and ranked, in
the next.

**Difficulty:** 8 points.

**Tests:** `engine/tests/durable-a1-checkpoint.test.js`, `engine/tests/durable-a2-resume.test.js`, `engine/tests/durable-a3-receipt-note.test.js`, `engine/tests/durable-a4-compaction.test.js`, `engine/tests/durable-a5-live-experiment.test.js`, `engine/tests/durable-a5-step-retry.test.js`, `engine/tests/durable-b1-directive-workflow.test.js`, `engine/tests/durable-b2-directive-resume.test.js`, `engine/tests/durable-b3-intake-perms.test.js`, `engine/tests/durable-d-live-experiment.test.js`, `engine/tests/durable-d1-cache-config.test.js`, `engine/tests/durable-d2-cache-measurement.test.js`, `engine/tests/durable-e1-memory-extract.test.js`, `engine/tests/durable-e2-memory-inject.test.js`, `engine/tests/durable-f1-engine-scan.test.js`, `engine/tests/durable-f2-engine-finalize.test.js`, `engine/tests/durable-f3-fallback-poller.test.js`, `engine/tests/durable-f4-retirement.test.js`, `engine/tests/durable-f5-triggers.test.js`, `engine/tests/durable-x1-idempotency.test.js`, and `engine/tests/durable-x2-pruning.test.js` (jest, 21 suites).

**Background:** F12 step C (story-linking). This is the durable
A–F + X program, the memory-and-checkpointing layer that makes
Spokbot's verified-work claim survivable: A = checkpoint store,
history validation, receipt summarization, compaction, step-failure
classification; B = directive identity (run ID derived from
channel:ts), cross-process resume, handoff-file permissions; D =
prompt-cache configuration and cross-provider usage measurement;
E = memory extraction and scoped, ranked injection; F = the
engine-side scan/finalize loop, fallback-poller mode decision,
legacy retirement accounting, and Hatchet scan triggers; X =
idempotency keys with an intent-before-effect ledger, and
retention pruning. Two suites (a5-live-experiment, d-live-experiment)
are live experiments that record measurements against the deployed
gateway rather than asserting fixed outcomes. Criteria are derived
from the suites' assertions; no suite was rewritten.

**Acceptance criteria:**

1. Given a checkpoint saved for a run, When it is loaded, Then
   messages, step index, tool results, tokens, and status round-trip
   exactly; given an unknown run ID, Then load returns null; and two
   runs never share checkpoint state.
2. Given a worker that dies after a checkpointed tool step, When a
   new process resumes the directive, Then it continues under the
   same run ID without re-executing the completed tool, and the
   dispatch record, checkpoint, and finalize step cross-reference
   that one run.
3. Given a side-effecting step, When it is attempted, Then its
   idempotency key is recorded as intent BEFORE the effect, and the
   ledger tracks none → intended → completed with the result.
4. Given a long history, When compaction runs, Then old tool
   results over the threshold are stubbed while the most recent is
   preserved in full, and content below the threshold is untouched.
5. Given a failed registration during the engine scan, When the
   scan advances, Then the watermark never passes the unregistered
   directive; given an artifact directive with no URLs or paths,
   Then it is dead-lettered at scan and the watermark advances.
6. Given extracted memory records, When a new task recalls, Then
   only that subject's and that agent's records are visible, ranked
   by relevance then recency, capped at the recall limit; and a
   receipt summary never claims artifacts from failed executions.
7. Given terminal checkpoints past the retention window, When
   pruning runs, Then exactly those are removed and the count is
   reported; given none eligible, Then zero are removed.
