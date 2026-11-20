# US-FW-020 — Configuration is explicit: the roster is complete and feature flags fail safe

**Story:** As a Spokbot operator, I want the framework's
configuration pinned by tests — the full agent roster present with
its required fields and channel memberships, and the Hatchet
workflow flag off unless explicitly enabled — so that a config edit
can never silently drop an agent from a channel or turn on an
experimental runtime path by accident.

**Difficulty:** 2 points.

**Tests:** `tests/config.test.js` and `tests/hatchetConfig.test.js` (jest, slack-agents root suites).

**Background:** F12 step C (story-linking). Two config surfaces:
the MACF config (the agent roster, per-agent required fields, and
channel membership — exec-pm in all channels, the marketing team in
#marketing) and the HATCHET config (ENABLED defaults false and only
the exact value `1` turns it on; CRON defaults to every 30 minutes
and is overridable). Criteria are derived from the suites'
assertions; no suite was rewritten.

**Acceptance criteria:**

1. Given the MACF config, When the roster is read, Then all agents
   are present, each carries its required fields, exec-pm is a
   member of every channel, and the marketing channel holds exactly
   its team.
2. Given no HATCHET_ENABLED in the environment, When the Hatchet
   config is read, Then ENABLED is false and CRON is the 30-minute
   default; given any value other than `1`, Then ENABLED stays
   false; given a CRON override, Then it is honored.
