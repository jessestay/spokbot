# US-FW-015 — Every agent loads, honors its role's intent rules, and proves its deliverables

**Story:** As a Spokbot operator, I want every agent module to
export the required interface and initialize without crashing, the
CCO's draft/publish intent to be classified by what the user
actually asked for, and assessment agents' deliverables to pass the
evidence gate only when they carry verifiable evidence — so that
the specialist roster the chief of staff delegates to is real,
role-faithful, and cannot fake its work.

**Difficulty:** 3 points.

**Tests:** `tests/agents.test.js`, `engine/tests/cco-classifier.test.js`, and `engine/tests/assessment-evidence.test.js` (jest).

**Background:** F12 step C (story-linking). Three agent-behavior
surfaces: the roster contract (every agent exports init /
handleMention / handleDelegation, initializes cleanly, and rejects
unmatched delegations), the CCO intent classifier (a "write a post"
request is a DRAFT and must never trigger publishing; only explicit
publish/post intent does), and the assessment-evidence contract
(assessment agents' written deliverables pass the poller gate only
with an evidence marker or verifiable content). Criteria are
derived from the suites' assertions; no suite was rewritten.

**Acceptance criteria:**

1. Given the agent roster, When each module is loaded, Then it
   exports init, handleMention, and handleDelegation, init runs
   without error, and handleDelegation rejects messages that do
   not match the agent.
2. Given a request like "Write X post" or "Draft X post", When the
   CCO classifies intent, Then it is a draft and publishing is not
   triggered; given "Publish to X" or "Post this to X", Then it is
   a publish intent.
3. Given an assessment agent's deliverable with an evidence marker,
   When the poller gate evaluates it, Then it passes; given no
   marker and no verifiable content, Then it fails the gate.
