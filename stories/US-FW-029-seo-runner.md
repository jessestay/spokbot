# US-FW-029 — The SEO runner audits live pages end to end

**Story:** As a Spokbot operator, I want the SEO runner — the live
loop around the deterministic core US-114 pins — to audit real
pages end to end with an injected fetch, so that a healthy page
passes every check, a broken page flags each defect by name, and a
non-200 response short-circuits to the status defect alone instead
of inventing content findings for a page it never saw.

**Difficulty:** 2 points.

**Tests:** `engine/tests/seo-runner.test.js` (jest).

**Background:** F12 step C (story-linking). US-114's step-B suite
pins `seoRunner`'s deterministic core (analyzePage / classifyDefect
/ recordChange); this suite covers the runner's end-to-end form —
the same analysis driven through the fetch-injected run path the
scheduled SEO job executes. Criteria are derived from the suite's
assertions; no suite was rewritten.

**Acceptance criteria:**

1. Given a healthy page, When analyzePage runs, Then every check
   passes; given a broken page, Then title, description, h1,
   canonical, og-tags, and viewport defects are each flagged.
2. Given a non-200 response, When the runner audits the page, Then
   it short-circuits to the status defect only.
3. Given the end-to-end run with an injected fetch, When it
   completes, Then its findings are the same checks the core
   applies — the live loop and the audited core cannot drift.
