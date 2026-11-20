Feature: Mechanical failure feedback to the working agent (US-104)
  As a working agent, I want the engine to tell me mechanically which
  postcondition failed, so that my next attempt fixes the actual gap instead
  of re-reading my own prose.

  Scenario: Failed postcondition is fed back as structured data
    Given verification failed on http_status for a contract URL
    When the task returns to WORKING
    Then my next cycle's context includes the structured failure
      {type: "http_status", url, expected: [200], observed: 404},
      not a human-written critique
