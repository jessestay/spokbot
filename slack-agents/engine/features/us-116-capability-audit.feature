Feature: Capability audit in the engine's own runtime context (US-116)
  As the CEO, I want every MCP baseline server verified daily in the
  engine's own runtime context, so that a server cannot be fixed in one
  context and broken in the one the team uses.
  (Acceptance suite: engine/tests/us-116-capability-audit.test.js)

  Scenario: Probes execute with the engine's environment and grants context
    Given the daily capability audit runs
    When it probes each baseline server
    Then the probe spawns the server with the engine process environment
      (including its HOME) plus the server's grants-configured env and
      working directory, authenticated as the CEO role

  Scenario: A failing baseline server is named as a baseline failure
    Given a baseline server whose probe fails or never answers
    When the audit report is built
    Then the report lists that server in baselineFailures, the audit
      writes the report to the state directory, and the run exits
      non-zero so the failure opens or updates a ticket the same day

  Scenario: A failing role-granted server is not a baseline failure
    Given a server granted to a role but not in the baseline set
    When its probe fails and every baseline server answers
    Then the report carries the failure in its per-server results but
      baselineFailures is empty
