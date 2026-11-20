Feature: Weekly content batch produced by the team (US-110)
  As a business owner, I want the weekly content batch produced by the
  MACF team on the team's own schedule, so that Monday's drafts are the
  team's work and blockers surface the same day.
  (Acceptance suite: engine/tests/us-110-content-batch.test.js)

  Scenario: The timer directive registers the batch to the CCO with a verifiable contract
    Given Monday 07:21 America/Denver
    When the team content-batch timer fires
    Then a directive is registered to the CCO whose contract requires
      the batch JSON to exist in the agent sandbox with at least 3
      drafts and at least one successful #content presentation receipt,
      so the batch is the team's work with no CEO authorship

  Scenario: Drafts ship with credited free-stock media when Canva is unavailable
    Given Canva is unavailable
    When the CCO produces the batch
    Then the directive requires every draft to still ship with media
      from a free stock source (Pexels, Pixabay, or Unsplash) with the
      source credited, and forbids a silently media-less draft

  Scenario: A tool failure surfaces as a blocker in the same run
    Given a tool the CCO needs fails
    When the run hits the failure
    Then the directive's blocker rule requires the blocker to be posted
      in the directive thread in the same run, where the standup relay
      carries it to the CEO

  Scenario: A run with no deliverable can never finalize as completed
    Given a run produces no deliverable
    When intake finalizes it
    Then the contract's postconditions (batch file exists, at least 3
      drafts, presentation receipt) cannot be satisfied by prose, so
      it finalizes as failed, never as completed
