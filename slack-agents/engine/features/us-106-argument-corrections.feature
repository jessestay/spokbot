Feature: Machine-readable argument corrections (US-106)
  As a working agent, I want a wrong argument name to come back as a
  machine-readable correction, so that I can fix the call mechanically on the
  next round.

  Scenario: Wrong argument name returns a structured correction, tool not invoked
    Given the agent calls urlCheck with {"arg": "https://example.com"} (the live Oct 12 incident)
    When executeTool validates
    Then the tool function is not invoked, and the result is errorClass "invalid_input"
      with a correction naming missing: ["url"] and unknown: ["arg"]

  Scenario: Repeating the identical violation short-circuits the loop
    Given the agent repeats the identical invalid call
    When the loop sees the repeated violation
    Then it short-circuits to a failed attempt instead of consuming further rounds
