Feature: Every recurring function exists as a story before it runs (US-118)
  As Jesse, I want every recurring team function to exist as a story in the
  planning system before it runs, so that no work is invisible to the team
  or to me.
  (Acceptance suite: engine/tests/job-submission-acceptance.test.js)

  Scenario: The registry covers every recurring function
    Given a recurring team function (content, SEO, finance, concierge,
      outreach, jobs)
    When the story registry is audited
    Then a story with acceptance criteria and a difficulty score exists
      for it (US-110 through US-123)
