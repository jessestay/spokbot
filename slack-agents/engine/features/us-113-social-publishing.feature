Feature: Approved social content publishes as live posts (US-113)
  As Jesse, I want approved social content to publish as live posts,
  so that content work produces visible outcomes and not only drafts.
  (Acceptance suite: engine/tests/us-113-social-publishing.test.js)

  Scenario: An approved draft that passed the team review loop publishes
    Given Jesse approves a draft from a batch that passed the team
      review loop
    When the publish step runs
    Then the post is live and its URL is recorded in
      published-posts.jsonl

  Scenario: Without approval, nothing publishes
    Given no approval
    Then nothing publishes — and at the engine's publish choke point
      the same fail-closed rule holds for quality: unscored or
      gate-rejected content throws before any network call, so
      nothing reaches a platform
