Feature: Receipt-backed demo relay (US-108)
  As Jesse (investor), I want every demo relayed to me to be backed by a
  receipt whose artifact still verifies, so that a link I click is a thing
  the engine itself made and just re-checked.

  Scenario: Prose alone never qualifies as a demo
    Given an agent posts prose containing a label, a URL-shaped string, and a task
      reference, but no artifact receipt exists for that task
    When the sprint demo check runs
    Then no [RELAY-DEMO] is emitted

  Scenario: A deleted artifact suppresses the relay
    Given a file artifact receipt exists but the file has been deleted since
    When the relay drain re-verifies
    Then the demo is not relayed and the stale receipt is flagged in telemetry
