Feature: Completion only on verified postconditions (US-103)
  As Jesse (investor), I want a task to be markable done only when its
  postconditions verify against the real world, so that "done" on my board
  always means the work observably happened.

  Scenario: Confident prose without the artifact does not complete the task
    Given task #702 has a contract requiring a fileWrite success and a file_exists postcondition
    When the agent's generation ends with confident prose but no file was written
    Then the task does not transition to DONE, vikunja.completeTask is not called,
      and the task returns to WORKING with a structured verification failure

  Scenario: Verified postconditions complete the task exactly once
    Given the same contract
    When the file exists with the recorded hash and minimum size
    Then the task transitions VERIFYING to DONE and vikunja.completeTask is called
      exactly once, from the completion module

  Scenario: Exhausted attempts block the task with a gap and no success post
    Given a task's attempts are exhausted
    When verification still fails
    Then the task transitions to BLOCKED, an engine gap is opened with the failing
      postconditions, and no success-shaped message is posted
