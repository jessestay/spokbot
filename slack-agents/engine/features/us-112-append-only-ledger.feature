Feature: Append-only applications ledger (US-112)
  As Jesse, I want the applications ledger to be append-only, so that
  recorded submissions can never be lost or silently reverted to an
  earlier stage.
  (Acceptance suite: engine/tests/job-submission-acceptance.test.js)

  Scenario: A recorded submission survives rebuilds and never regresses
    Given a recorded submission
    When any prepare or rebuild process runs
    Then the record remains and its stage never regresses

  Scenario: A refused write is loud and leaves the ledger intact
    Given a ledger write failure (a record with no confirmation reference)
    When the write is attempted
    Then the failure is loud in the run log (the writer throws) and the
      prior ledger stays byte-identical

  Scenario: Appends never rewrite history
    Given a first recorded submission
    When a second submission is appended
    Then the first record's bytes are an untouched prefix of the ledger
