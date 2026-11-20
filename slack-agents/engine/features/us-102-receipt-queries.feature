Feature: Querying what an agent actually did (US-102)
  As the CEO agent, I want to query what an agent actually did on a task,
  so that my standup reports effects, not claims.

  Scenario: Receipts for a task are queryable without reading prose
    Given receipts exist for task #702
    When I call receiptsForTask(702)
    Then I receive the full ordered list of tool calls with statuses and artifacts,
      without reading any Slack message or deliverable text
