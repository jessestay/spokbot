Feature: Structured receipts for every tool execution (US-101)
  As the engine, I want every tool execution to issue a structured receipt,
  so that completion decisions never depend on an agent's prose.

  Scenario: Successful fileWrite issues a receipt with a verifiable artifact
    Given an agent calls fileWrite successfully for task #702
    When executeTool returns
    Then a receipt exists in the ledger with tool "fileWrite", status "ok", the task ID,
      and a file artifact whose sha256 matches the file on disk

  Scenario: Unknown tool issues a receipt like every other path
    Given an agent calls a tool name that does not exist
    When executeTool returns
    Then a receipt with status "error" and errorClass "unknown_tool" exists

  Scenario: Failed tool call records its class and no artifacts
    Given a tool call fails
    When the receipt is written
    Then it records the classified errorClass and no artifact entries
