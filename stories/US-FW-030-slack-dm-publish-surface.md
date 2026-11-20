# US-FW-030 — The Slack surface resolves tokens, recognizes DMs, and unit-tests the publisher

**Story:** As a Spokbot operator, I want the Slack surface's
plumbing pinned — token resolution that prefers the environment
and falls back to the vault surrogate without ever shelling out,
DM detection that reads the event shape before the ID prefix, and
the publisher's unit behavior — so that the channels the whole
team speaks through fail in known ways, never in surprising ones.

**Difficulty:** 3 points.

**Tests:** `tests/dm.test.js`, `tests/slackToken.test.js`, and `engine/publisher.test.js` (jest; the last is an engine-root suite outside jest's testMatch — a known runner gap the linkage lint keeps visible; US-113 pins the publisher's gate behavior end to end).

**Background:** F12 step C (story-linking). The surface layer
beneath US-107/US-113: resolveSlackToken (env first, empty env
counts as unset, the custom.slack surrogate as fallback, null —
not a throw — when the surrogate fails), the DM helpers
(isDMChannelId / isDMEvent / openDM with channel caching), and the
publisher's own unit suite. Criteria are derived from the suites'
assertions; no suite was rewritten.

**Acceptance criteria:**

1. Given SLACK_BOT_TOKEN set, When the token resolves, Then the
   env value wins and nothing shells out; given it unset or empty,
   Then the surrogate supplies the token; given the surrogate
   throws, Then resolution returns null.
2. Given an event, When DM-ness is decided, Then channel_type is
   checked first and the D-prefix second; given a DM open, Then
   the channel is cached for reuse.
