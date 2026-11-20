Feature: SEO recommendations turned into changed pages (US-114)
  As Jesse, I want SEO recommendations turned into changed pages on
  staynalive.com, so that SEO counts as action, not just knowledge.
  (Acceptance suite: engine/tests/us-114-seo-changes.test.js)

  Scenario: An approved SEO change ships, verifies on re-audit, and is recorded
    Given an approved SEO change for a page the audit flags as
      defective
    When the runner executes it
    Then the page content differs at its URL — the same check that
      failed now passes on re-audit — and the change is recorded in
      the changes ledger with its URL and approver, the only record
      the outcome audit counts as an SEO change

  Scenario: Unapproved or off-property changes are never recorded
    Given a change record for a URL outside Jesse's properties, or
      one with no description of what shipped
    When it is submitted to the changes ledger
    Then it is rejected loudly and nothing is recorded — knowledge
      and third-party pages never count as action
