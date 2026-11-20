Feature: Schema-valid deliverables only (US-105)
  As the engine, I want contracted tasks to accept only schema-valid
  deliverables, so that tool-call syntax or narration in the final text is a
  failed attempt by construction.

  Scenario: The original task #702 output is an invalid deliverable
    Given task #702's contract specifies deliverable.schema "research-report@v1"
    When the model's final output is [fileRead(path="reports/x.md")] as text
    Then the generation returns errorClass "invalid_deliverable", the attempt is
      recorded as failed, and nothing is posted or relayed

  Scenario: Schema-invalid JSON returns field-level errors
    Given the model returns JSON that fails the schema
    When validation runs
    Then the specific field errors are returned in validationErrors and the attempt
      fails without any text-pattern matching being consulted
