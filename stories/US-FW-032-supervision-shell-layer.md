# US-FW-032 — The supervision shell layer keeps its own invariants

**Story:** As a Spokbot operator, I want the supervision shell
layer — the runner every supervision check executes through, the
liveness probe, the token-health check, and the unit inventory —
pinned by tests, so that the layer whose entire job is noticing
silent failure cannot itself fail silently: stamps are written
atomically, exit codes propagate, health means execution (not just
process presence), and alerts fire on transitions, not on a loop.

**Difficulty:** 5 points.

**Tests:** `tests/supervisionShell.test.mjs` (node:test, dependency-free).

**Background:** F12 step D — the first coverage for a
zero-coverage area, picked by risk: this layer's failure mode is
the silent kind (a dead watchdog means a dead engine goes
unnoticed; the system's own history includes a standup runner
silently stale for days and Vikunja dying three times before the
setsid fix). The framework tree's `supervision/` holds the runner
(`run.sh`), the checks (`liveness.sh`, `token_health.sh`,
`backup.py`, `directive_watch.py`, `resilience_watch.py`,
`task69_watch.py`, and the shared `slack_alert.py` helper), and
the installed-unit inventory (`UNITS.txt`, 15 service/timer
pairs). Two findings recorded plainly: (1) the anchored-pkill /
setsid invariants from the plan belong to the Vikunja start.sh
class of scripts (covered by US-FW-018) — this layer launches
nothing itself, and the suite guards that no unanchored pkill or
bare nohup launch creeps into it; (2) the layer's scripts still
hardcode the production server's absolute paths — the US-FW-002
sweep covered the slack-agents tree, not `supervision/` — so this
first suite pins the scripts' contracts statically; parameterizing
the supervision paths (and with it, functional sandbox runs) is a
follow-up story, not claimed here.

**Step 6/7 scoping note (2026-11-19) — parameterization follow-up
assessed, NOT implemented here:** the hardcoded absolutes are all
the old production layout (`/home/ubuntu/workspace/macf/…`, 17
sites across run.sh + 7 check scripts). It is not the
instancePaths pattern mechanically — that is a JS module; this
layer is bash/python with no shared config loader — and these
scripts are copies of the HELD production supervision layer
(Step 5 disposition: held deliberately, so the verification gate's
ruler does not move mid-measurement). Several absolutes are
semantically production-pointing (the engine log path, the
engine-home HOME): misparameterizing them blinds the watchdog,
the failure class this story exists to prevent. Scoped finding
recorded in the Step 6/7 report: the safe shape is a follow-up
story adding env-first root resolution with the current
production paths as defaults (zero behavior change unset), pins
that default-equals-current in this suite, and lands together
with the held-layer deployment decision — not before it.

**Acceptance criteria:**

1. Given the unit inventory, When it is parsed, Then every entry
   is a macf-sup-<name> service/timer pair with both halves
   present and no duplicate names; and every check script is
   either mapped to an inventory unit or is the shared alert
   helper other checks import.
2. Given any supervised command, When run.sh executes it, Then
   output is appended to the named log with timestamps, the stamp
   file is replaced atomically (tmp + mv) with "<epoch> <exit
   code>", and run.sh exits with the command's own exit code.
3. Given the liveness probe, When it evaluates health, Then it
   requires all four services active, the Vikunja API at 200, the
   gateway's liveliness endpoint at 200 (never the deep /health
   endpoint that 500s on a down model leg), and the engine log
   fresh within 600 seconds — presence is not health.
4. Given a liveness state transition, When the probe completes,
   Then exactly one Slack alert posts; given no transition, Then
   none does; and the probe exits non-zero while anything is down.
5. Given the token-health check, When it runs, Then the MCP
   connectivity proof runs first and the metadata check's exit
   code is the service result.
6. Given any script in the layer, When it is scanned, Then it
   contains no unanchored pkill and no bare nohup launch (the
   Oct 10, 2026 failure class cannot regress into this layer).
