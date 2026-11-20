Feature: Directive dead-letter store inspected daily (US-117)
  As the CEO, I want the directive dead-letter store inspected daily,
  so that no directive dies silently.
  (Acceptance suite: engine/tests/us-117-dead-letter.test.js)

  Scenario: A dying directive lands in the store with its text and reason
    Given a directive that cannot be actioned (an unparseable header,
      or a review request naming artifacts but providing no URLs/paths)
    When the scan runs
    Then the entry lands in the dead-letter store carrying the
      directive text and the failure reason, and it is never registered
      as live work

  Scenario: A due dead-letter is re-posted correctly
    Given a dead-lettered directive whose cooldown has elapsed and
      whose requeue budget remains
    When the daily check drains the store
    Then the directive re-enters the delegation queue with an
      incremented requeue count and leaves the store

  Scenario: An exhausted or unactionable entry is closed with a stated reason
    Given a dead-lettered directive that has exhausted its requeues,
      or one that can never be re-registered (no full text to re-post)
    When the daily check drains the store
    Then it stays in the store permanently, marked as finally logged,
      with its reason on record — visible to the CEO's standup and the
      park-ticket drain instead of vanishing
