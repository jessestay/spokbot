Feature: Watchdog keeps the stack up by execution health (US-123)
  As Jesse, I want the engine, Vikunja, gateway, and n8n kept up by a
  watchdog that auto-restores known failure classes, so that health
  means workflows actually execute, not that a heartbeat is fresh.
  (Acceptance suite: engine/tests/us-123-watchdog-liveness.test.js)

  Scenario: A stack that can execute nothing is judged dead even while its processes live
    Given a known failure class occurs — the engine's database is
      gone, or the engine heartbeat goes stale while every process
      still exists
    When the watchdog evaluates liveness
    Then the verdict is based on execution evidence (database
      presence plus heartbeat freshness), never on process presence
      alone

  Scenario: A transient failure never triggers a restore
    Given a single bad evaluation — a slow boot or one transient
      read
    When the next evaluation is healthy
    Then the strike count resets and no kill or relaunch is ordered:
      only consecutive bad evaluations reaching the strike limit
      declare the stack a zombie for the watchdog to restore
