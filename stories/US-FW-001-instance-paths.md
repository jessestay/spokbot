# US-FW-001 — The kernel resolves instance content through SPOKBOT_INSTANCE_DIR / SPOKBOT_STATE_DIR

**Story:** As a Spokbot operator running my own instance, I want the
kernel to find my personas, automations, config, and runtime state
through `SPOKBOT_INSTANCE_DIR` and `SPOKBOT_STATE_DIR` — with config
precedence framework defaults → instance `config/` → environment —
so that the framework ships with zero operator-specific paths
hardcoded and my deployment keeps working unchanged until I choose
the split layout.

**Difficulty:** 8 points.

**Acceptance criteria:**

1. Given no environment overrides, When the kernel resolves the
   instance dir, Then it gets the framework tree root (today's
   unsplit layout), and the state dir resolves to
   `<slack-agents>/.state` — exactly today's paths.
2. Given `SPOKBOT_INSTANCE_DIR` is set, When the kernel resolves an
   instance content path (e.g. team-skills), Then the path is under
   that directory — preferring the split layout (`personas/…`) when
   it exists there, and falling back to the unsplit layout
   (`<instance>/team-skills`) when it does not.
3. Given `SPOKBOT_STATE_DIR` is set, When the kernel resolves a state
   file, Then it is under that directory; Given it is unset, Then
   state files resolve under the default from criterion 1.
4. Given a config name (e.g. `models.yaml`), When the kernel resolves
   it, Then an explicit env override wins; else the instance
   `config/` copy wins over the framework default; else the framework
   default (`slack-agents/config/`) is used — so with the instance dir
   pointed at today's tree, resolution returns today's file.
5. Given the parameterized kernel, When the expert-lens loader runs
   with `SPOKBOT_INSTANCE_DIR` pointed at a real instance (split or
   unsplit layout), Then it loads the instance's `jesse-voice.md`
   content from that instance, not from any hardcoded machine path.
6. Given the framework tree, When it is scanned, Then it contains no
   `team-skills/` content, no live `grants.json`, no runtime state
   files, and no credential files (the Finding 3 move).

**Tests:** `tests/instancePaths.test.mjs` (node:test, dependency-free;
run `node --test tests/`). Each test names the criterion it proves.
