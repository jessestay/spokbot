# US-FW-011 — The kernel verifies itself: no completion without receipts, contracts, and proof

**Story:** As a Spokbot operator, I want the kernel's own behavior
pinned by verification suites — directive parsing in every arrow
dialect, unexecuted tool-call syntax detected in every leak dialect,
strict tool schemas, contract stamping and postcondition checking,
Jesse-gating, loop accounting, self-healing that closes only on a
passed test, execution timeouts, and liveness probing — so that
"verified work" is a property the system proves about itself on
every run, not a claim an agent makes in prose.

**Difficulty:** 8 points.

**Tests:** `engine/tests/kernel-m1-758.test.js`, `engine/tests/kernel-m1-arrowdialects.test.js`, `engine/tests/kernel-m1-leakdialects.test.js`, `engine/tests/kernel-m1-verify.test.js`, `engine/tests/kernel-m2-strict.test.js`, `engine/tests/kernel-m2-workflow.test.js`, `engine/tests/kernel-m3-gate.test.js`, `engine/tests/kernel-m3-loop.test.js`, `engine/tests/kernel-m3-stamp.test.js`, `engine/tests/kernel-m3-verifyid.test.js`, `engine/tests/kernel-m4-healer.test.js`, `engine/tests/kernel-m5-timeout.test.js`, `engine/tests/kernel-breaker.test.js`, `engine/tests/kernel-resilience.test.js`, `engine/tests/kernel-p1-gate.test.js`, `engine/tests/kernel-p2-harness.test.js`, `engine/tests/kernel-p2-mcp.test.js`, `engine/tests/kernel-p2-tools.test.js`, `engine/tests/kernel-p2-wordpress.test.js`, `engine/tests/kernel-p3-content-batch.test.js`, `engine/tests/kernel-p3-content-batch-r4.test.js`, `engine/tests/kernel-p3-content-batch-r5.test.js`, `engine/tests/kernel-p3-postconditions.test.js`, `engine/tests/kernel-p3-signals.test.js`, and `engine/tests/kernel-p4-liveness.test.js` (jest, 25 suites).

**Background:** F12 step C (story-linking). These are the M1–M5 and
P1–P4 kernel suites plus the breaker/resilience pair — the kernel's
self-verification layer, built milestone by milestone. M1: header
parsing across arrow dialects, leak-dialect detection of unexecuted
call syntax (the #702 failure class), and the rule that an
artifact-less claim is unverifiable, never auto-verified. M2: strict
schema normalization and the task-work workflow step. M3: the
Jesse-gate (tasks addressed to Jesse are gated; gate words inside a
team workflow are not), LOOP-run accounting, floor-contract
stamping, and verification IDs on completions. M4: the healer
closes a repair only when its verification test passes. M5: a hung
execution becomes a failed attempt via timeout. P1: the local-route
quality gate. P2: harness framing and budgets, MCP grants in the
delegation loop, sandbox-aligned code reading, the WordPress tool.
P3: contract-carried postconditions, entity-unescape handling,
the slackPost role gate, and the postcondition outcomes ledger
(the #925 content-batch machinery US-110's contract relies on).
P4: the watchdog liveness probe (US-123's framework half).
Criteria are derived from the suites' assertions; no suite was
rewritten. (`engine/tests/kernel-p3-vikunja-tool.test.js` belongs
to this family by name and is linked from US-FW-017, the Vikunja
story, by subject.)

**Acceptance criteria:**

1. Given a directive header in Unicode-arrow, ASCII-arrow, or
   agent-to-agent form, When it is parsed, Then the target agent
   resolves identically; given tool-call syntax leaked as prose in
   any known dialect (DSML, control tokens, bare call text), When
   the detector scans it, Then it is flagged as unexecuted.
2. Given a completion claim with no artifacts, When verification
   runs, Then the disposition is unverifiable — never verified —
   regardless of how keyword-rich the claim is.
3. Given a task addressed to Jesse, When gating is evaluated, Then
   it is gated for his approval; given a team workflow that merely
   mentions an approval step, Then it is not gated.
4. Given a bare task description, When the contract stamper runs,
   Then the floor contract is stamped exactly once; given derived
   postconditions, When they are verified, Then an existing file
   satisfies and a missing file fails with the observed state.
5. Given a repair with a verification test, When the test fails or
   errors, Then the repair stays open; only a passing test closes
   it. Given an execution that never settles, When the timeout
   fires, Then it rejects as a failed attempt, not a hang.
6. Given a contracted task on a local route with a text-only answer
   and tools offered, When the P1 quality gate evaluates, Then the
   outcome is no_result, never done.
