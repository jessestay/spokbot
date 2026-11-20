Feature: Deliverables counted only when actually sent (US-115)
  As Jesse, I want client deliverables counted only when actually
  sent, so that drafts are never reported as deliveries.
  (Acceptance suite: engine/tests/outcome-audit.test.js)

  Scenario: A completed package with no send reference counts as zero deliveries
    Given a completed proposal package recorded in the deliveries
      ledger without any send reference
    When the outcome audit reports deliverables
    Then the package does not count — a draft is not a delivery

  Scenario: A package with a send reference counts exactly once
    Given a completed proposal package whose ledger entry carries a
      send reference (a message id or a sent-record reference) in
      deliveries.jsonl
    When the outcome audit reports deliverables
    Then the package counts as one delivery, attributable to its
      client and day
