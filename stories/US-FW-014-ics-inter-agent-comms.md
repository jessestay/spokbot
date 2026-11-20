# US-FW-014 — Investor comms are validated, idempotent, and delivered once

**Story:** As a Spokbot operator, I want the inter-agent comms
system (ICS) — the bus that carries notifications to the investor —
to validate every submission against its schema before anything is
sent, mint a fresh idempotency key per submission, authorize only
the active CEO as sender, and batch outcomes into a single digest,
so that Jesse is informed exactly once per event and never by a
malformed or duplicated message.

**Difficulty:** 5 points.

**Tests:** `tests/ics-adapters.test.js`, `tests/ics-audit.test.js`, `tests/ics-bus.test.js`, `tests/ics-client.test.js`, `tests/ics-digest.test.js`, `tests/ics-mcp.test.js`, `tests/ics-registry.test.js`, and `tests/ics-schema.test.js` (jest, slack-agents root suites).

**Background:** F12 step C (story-linking). ICS is the framework's
outbound comms bus: schema validation, the bus fan-out, the client
that mints idempotency keys, the registry that resolves the active
CEO and authorizes the sending engine, surface adapters (the
Slack-DM adapter wraps dmJesse and refuses non-CEO agents), the
append-only JSONL audit log, and the digest that drains queued
outcomes into one message. Criteria are derived from the suites'
assertions; no suite was rewritten.

**Acceptance criteria:**

1. Given a submission with a bad type or an out-of-range priority,
   When it reaches the bus, Then it is rejected before anything is
   sent — and validation runs before the registry check; given a
   fully valid submission, Then it fans out to every surface.
2. Given any client submission, When the idempotency key is minted,
   Then it is a fresh UUID on every call — even when the caller
   supplies one of their own.
3. Given a non-CEO agent attempting to DM Jesse through the
   adapter, When delivery is attempted, Then the gate refuses and
   nothing is posted; given the CEO agent, Then the DM opens and
   the message carries subject and body.
4. Given audit entries appended in order, When they are read back,
   Then they return in append order with fields intact, one JSON
   object per line on disk, and the caller's object is never
   mutated by appending.
5. Given queued outcomes, When the digest builds, Then it composes
   one text with every outcome as a short bullet; given an empty
   queue, Then the digest is an empty string, not a message.
