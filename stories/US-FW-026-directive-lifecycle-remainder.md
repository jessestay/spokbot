# US-FW-026 — Directive lifecycle: one processor, bounded retries, parsed contracts, verified posts

**Story:** As a Spokbot operator, I want the remaining joints of
the directive lifecycle pinned — exactly one processor owning each
directive (no split-brain between the poller and the agent path),
failed directives queued for retry with dedupe and a hard bound,
MACF contracts parsed from task descriptions without ever throwing,
and Slack posts verified by read-after-write — so that a directive
is never worked twice, never retried forever, and never reported
posted when it was not.

**Difficulty:** 3 points.

**Tests:** `engine/tests/directiveRetryQueue.test.js`, `engine/tests/single-processor.test.js`, `engine/tests/taskContract.test.js`, and `engine/tests/post-verification.test.js` (jest).

**Background:** F12 step C (story-linking). US-103/104/105 cover
the lifecycle's core and the durable suites (US-FW-010) its
checkpointed form; these four suites cover the seams: the
single-processor rule (CEO-addressed directives are the poller's
job and the agent path skips them — case-insensitively — while
agent-to-agent directives and plain mentions still process), the
retry queue (dedupe of repeat queueing, text truncation, the
MAX_PENDING_RETRY bound), contract parsing (a contract block
extracts; absent or malformed or non-contract JSON yields null,
never a throw), and post verification (the posted ts must be found
in the readback, else the post counts as failed). Criteria are
derived from the suites' assertions; no suite was rewritten.

**Acceptance criteria:**

1. Given a `[from: CEO → CCO]` directive in any casing, When the
   agent-side processor scans, Then it skips it — the poller owns
   it; given an agent-to-agent directive or a plain mention, Then
   it processes.
2. Given the same failed directive queued twice, When the retry
   queue records it, Then it holds one entry; given more failures
   than MAX_PENDING_RETRY, Then the queue stays bounded and long
   texts are truncated.
3. Given a task description with a contract block, When the
   contract is parsed, Then it extracts; given an absent block,
   malformed JSON, or JSON that is not a contract object, Then
   the result is null and nothing throws.
4. Given a posted message, When verification reads back the
   channel, Then it passes only if the posted ts is found; a
   missing ts, a missing readback entry, or an empty readback all
   fail the verification.
