# US-FW-023 — The tasks surface keeps substance and drops noise

**Story:** As a Spokbot operator, I want the tasks surface to tell
real work from chatter — short acknowledgements classified as
noise, substantive descriptions kept, and delegations tracked — so
that the board the team plans against reflects work, not every
message that happened to fly past.

**Difficulty:** 2 points.

**Tests:** `tests/tasks.test.js` (jest, slack-agents root suite).

**Background:** F12 step C (story-linking). The tasks module's
classification half: isNoise separates short acks from substantive
work descriptions (longer acks that describe work are kept), and
trackDelegation records delegation traffic for the surface.
Criteria are derived from the suite's assertions; no suite was
rewritten.

**Acceptance criteria:**

1. Given a short acknowledgement, When it is classified, Then it
   is noise; given a substantive work description — including a
   longer acknowledgement that describes work — Then it is kept.
2. Given a delegation, When it is tracked, Then the tasks surface
   records it for the board.
