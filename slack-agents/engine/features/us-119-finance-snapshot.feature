Feature: CFO daily finance snapshot and expense recording (US-119)
  As Jesse, I want the CFO to run a daily finance snapshot and land
  every newly discovered expense in my budget sheet in the same pass,
  so that revenue operations reflect real money movement, not plans.
  (Acceptance suite: engine/tests/us-119-finance-snapshot.test.js)

  Scenario: A new expense lands in the same pass and the snapshot reconciles
    Given a new expense appears in any linked account's recorded data
    When the CFO finance pass runs
    Then the expense is recorded once — it surfaces exactly once in
      the snapshot's obligations and flags — and the daily snapshot
      totals reconcile exactly with the account feeds: net cash is
      the sum of the recorded balances, due-soon totals are the sum
      of the unpaid obligations due in the window, and nothing is
      invented or double-counted

  Scenario: A malformed expense record can never enter the snapshot
    Given a recorded expense with a missing name, a non-numeric
      amount, or an invalid due date
    When the finance refresh validates the recorded inputs before
      the check runs
    Then validation fails loudly naming the defect, so corrupt data
      is stopped at the gate instead of landing in the snapshot
