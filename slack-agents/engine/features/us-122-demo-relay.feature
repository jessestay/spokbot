Feature: Agent demos relayed to Jesse (US-122)
  As Jesse, I want every agent to produce visible demos that are
  relayed to me after the agent demos to the CEO, so that silence from
  any agent is treated as breakage, not as a quiet week.
  (Acceptance suite: engine/tests/us-122-demo-relay.test.js)

  Scenario: A completed piece of work with a live artifact receipt qualifies as a demo
    Given an agent completes demonstrable work
    When the hourly demo check runs
    Then a qualifying demo — carrying its label, artifact link, and
      task reference from the receipt itself — is relayed to Jesse

  Scenario: An agent with no qualifying demo in the window is flagged by name
    Given an agent whose task holds no artifact receipt in the window,
      or whose artifact fails re-verification (deleted or changed
      since the receipt was issued)
    When the hourly demo check runs
    Then the task does not qualify, the reason is on record, and the
      agent's silence is visible as breakage rather than a quiet week
