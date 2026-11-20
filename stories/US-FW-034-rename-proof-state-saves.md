# US-FW-034 — Rename-proof atomic saves for symlinked state files

**Story:** As the CEO executing a Step 5-class cutover, I want the
engine's atomic state saves to land on the real file behind a symlink
instead of replacing the symlink itself, so that a staged tree whose
state files are symlinked to production (runbook F11) keeps sharing
one state object with production after the first save, not just
until it.

**Difficulty:** 3 points.

**Tests:** `tests/directiveStateRename.test.mjs` (node:test, dependency-free).

**Background:** The third Step 5 attempt (2026-11-18 21:44 UTC)
passed the W6 capability gate and F10 held, but rolled back at the
W7 extended state-pin proof, item (d): the new engine's first
directive-scan save wrote `engine/.directive-poll-state.json`
atomically (tmp + `rename()`), and a rename over a symlink path
replaces the symlink itself with the tmp file. The staged path came
back a regular file (ino 3230104) instead of the production file
object (ino 524491). Contents were byte-identical — the engine had
read production state through the link, then wrote it back over the
link — so nothing diverged, but the structural guarantee F11 exists
to provide was broken from the first save onward.

The writer audit for this fix (runbook, attempt-4 fix-pass block)
found exactly one rename-based writer among the F11 files:
`engine/directiveState.js` `savePollState()` (used by both the
poller and the engine scan/finalize loops). Every other F11 writer
(`directiveVerify.js`, `directiveFinalize.js`, `engineGap.js`,
`demoRelay.js`, `workEngine.js`, `autonomousRunner.js`,
`self-healer.js`, `qualityTrends.js`, `sprintDemo.js`,
`toolUsageAuditor.js`, `completion.js`) saves with a direct
`writeFileSync`, which follows symlinks and is safe by mechanism.
The F10 `.state` writers include several rename-based saves
(`managerStandup.js`, `proactivitySweep.js`, `relayLedger.js`,
`directiveIntake.js`, `directiveRetirement.js`,
`checkpointAdapters.js`, `circuitBreaker.js`), but F10 symlinks the
`.state` DIRECTORY: each writer's tmp file is created inside the
resolved (production) directory and the rename replaces a directory
entry inside it, so the directory symlink is never the rename
target and the mechanism is safe regardless of save style.

**The fix:** `savePollState()` resolves the target's real path
before creating its tmp file — the tmp is created beside the REAL
target and the rename lands on it, leaving any symlink at the
configured path intact. When the target does not exist yet, a
dangling symlink's target is aimed at directly (so the first save
creates the target and the link survives); a plain missing path
falls back to the unresolved path and is created exactly as before.
State file locations do not move: the held supervision layer reads
these files at the production `engine/` paths.

**Acceptance criteria:**

1. Given a state path that is a symlink to a real file, When
   `savePollState` saves through it, Then the configured path is
   still a symlink to the same target afterward.
2. Given a state path that is a symlink to a real file, When
   `savePollState` saves through it, Then the saved content is the
   content of the link target (and no tmp litter remains).
3. Given a plain non-symlinked state path, When `savePollState`
   saves, Then behavior is exactly as before: the state is
   returned, the file is atomically replaced, and the saved file
   carries the two-user handoff mode (0666).
4. Given a state path whose target does not exist yet, When
   `savePollState` saves, Then the file is created with the saved
   content — including when the path is a dangling symlink, in
   which case the target is created and the link survives.
