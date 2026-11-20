# US-FW-028 — Quality gates fail closed: unscored or malformed work never passes

**Story:** As a Spokbot operator, I want the content and visual
quality gates — and the capability-gap signal that fires when an
agent cannot do what a task needs — to validate strictly and fail
closed, so that a draft or visual missing its required fields, an
unknown platform or persona, or a malformed gap signal is rejected
at the gate instead of reaching Jesse or a channel.

**Difficulty:** 3 points.

**Tests:** `engine/tests/gates/content-gate.test.js`, `engine/tests/gates/visual-gate.test.js`, `engine/tests/gates/jasmine-star.test.js`, and `engine/tests/gates/missing-capability.test.js` (jest).

**Background:** F12 step C (story-linking). US-107 covers the
deterministic executors; the gates are the scoring layer in front
of them (US-110's batch and US-113's publisher both consume gate
verdicts): the content gate's schema and scoring (required fields,
known platforms, personas in the platform map), the visual gate's
schema and scoring (required fields, known base types, stock-first
visuals scoring per rule), the jasmine-star review principles
(every principle carries an id, a description, and the Star
question; a glossy pure-AI brief is flagged — real over glossy),
and the missing-capability signal (well-formed, timestamped,
persisted to the queue; an empty missing list, or a signal with no
agent or task, is rejected — that is not a capability gap).
Criteria are derived from the suites' assertions; no suite was
rewritten.

**Acceptance criteria:**

1. Given a draft missing required fields, an unknown platform, or
   a persona outside the platform map, When the content gate
   validates, Then it is rejected (fail closed); given a valid
   draft, Then it is scored per rule.
2. Given a visual missing required fields or with an unknown base
   type, When the visual gate validates, Then it is rejected;
   given a strong stock-first visual, Then it passes with per-rule
   scores.
3. Given a brief that is glossy and purely AI-generated, When the
   jasmine-star review runs, Then it is flagged against the
   real-over-glossy principle; given any principle, Then it
   carries an id, a description, and the Star question.
4. Given a capability signal with an empty missing list or no
   agent or task, When it is emitted, Then it is rejected; given a
   well-formed signal, Then it is timestamped and persisted to the
   queue.
