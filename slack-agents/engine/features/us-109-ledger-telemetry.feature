Feature: Telemetry computed from the receipts ledger (US-109)
  As the CEO agent, I want tool-usage telemetry computed from the receipts
  ledger, so that standup numbers describe recorded events rather than regex
  inferences.

  Scenario: Summary counts match the ledger exactly
    Given 24 hours of receipts including failures
    When summarize() runs
    Then per-agent and per-class counts match the ledger exactly, and disabling
      every narration/text detector changes none of the counts
