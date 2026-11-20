Feature: Deterministic executors for mechanical task shapes (US-107)
  As the CEO agent, I want mechanical task shapes to run as code, so that
  fetching, checking, and filing happen identically every cycle with no model
  in the loop.

  Scenario: URL sweep checks everything before any model call
    Given a task whose contract names executor "url-sweep" with three URLs
    When the work cycle runs
    Then all three URLs are checked via executeTool (three receipts exist) before
      any model call is made, and the model is invoked at most once, only to
      summarize observed differences

  Scenario: Invalid generative output does not complete the task
    Given an executor's generative step returns schema-invalid output
    When the executor finishes
    Then the mechanical receipts stand, the deliverable is marked failed,
      and the task is not completed
