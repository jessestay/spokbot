Feature: Team job submission through its own execution seat (US-111)
  As Jesse (investor/chairman), I want the MACF team to submit job
  applications itself through its own browser execution seat, so that
  submissions do not depend on the CEO's personal browser.
  (Vikunja #935; acceptance suite: engine/tests/job-submission-acceptance.test.js)

  Scenario: A submission counts only with a portal confirmation
    Given a resume_ready candidate and a banked answer for every form question
    When the submit timer runs
    Then a submission is recorded in applications.jsonl with a portal
      confirmation reference and no CEO browser involved
    Note: the browser walk itself is #935 step 6 (not yet built); this suite
      verifies the deterministic boundary the built machinery owns — queue,
      answer map, consumer decision, and the confirmation-only ledger write,
      including the executor seat stored on the entry.

  Scenario: An unbanked question stops the run and is never guessed
    Given a question with no banked answer
    When the form is reached
    Then the run stops, logs the exact question as a blocker, and submits
      nothing

  Scenario: The consumer refuses to run live in this build
    Given the consumer is invoked without --dry-run
    When it starts
    Then it refuses with exit code 2 and writes nothing anywhere

  Scenario: A dry run changes no state
    Given a scratch queue with one covered and one already-submitted candidate
    When the consumer runs with --dry-run
    Then it exits 0, skips the submitted candidate, reports the covered one
      as would-submit, and the ledger, blocker log, and queue are unchanged

  Scenario: Dead postings leave the queue; other blockers keep their seat
    Given a candidate block-logged as a closed or removed posting
    When the queue is built
    Then it is pruned and counted in prunedDead, while a candidate blocked
      on an unbanked question keeps its queue seat

  Scenario: PDF coverage counts only verified PDFs
    Given queued candidates with markdown resumes
    When prepare() runs with no PDF cap
    Then every queued candidate has a resume.pdf whose first bytes are the
      %PDF- magic, and a plain-text stub named resume.pdf never counts
