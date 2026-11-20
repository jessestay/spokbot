# US-FW-005 — One-command Docker install for the framework (draft)

**Story:** As a new Spokbot operator evaluating the framework, I want
to stand up the kernel with one command (`docker compose up -d`)
from a clean checkout — engine, task board, and model gateway wired
together, my instance data mounted from outside the image — so that
the first run takes minutes, keeps my data and secrets out of the
image, and fails legibly when I have not configured it yet.

**Difficulty:** 5 points.

**Tests:** `tests/dockerInstall.test.mjs` (node:test, dependency-free).

**Background:** Step 7 of the Phase 1 plan includes a Docker Compose
one-command install. This story covers the ungated drafting parts
only: the compose file, the Dockerfile, and the README section. It
does NOT publish anything, does not touch the public repo, and is not
a claim that the stack has been run end to end — no Docker daemon is
available in the build environment, so verification here is
structural (the compose file parses; every path it references exists
in the tree; the documented steps match the files). A live
`docker compose up` verification on an operator machine remains a
Step 7 gate item.

The shape follows how production actually runs (Step 0R baseline):
the engine is `node engine/runStandalone.js` from `slack-agents/`
and exits with a clear message when Slack/Vikunja are unconfigured;
the gateway is a self-hosted LiteLLM proxy on :4000 configured by
`gateway/litellm_config.yaml`; the task board is Vikunja (the engine
refuses to start without `VIKUNJA_URL`/`VIKUNJA_TOKEN`); instance
data and state resolve through `SPOKBOT_INSTANCE_DIR` /
`SPOKBOT_STATE_DIR` (US-FW-001), so both are mounted, never baked in.
Ollama is an optional Compose profile (`local-models`), matching the
staged local-first routing profile. Secrets come from
`slack-agents/.env` (copied from the shipped `.env.example`), never
from the image.

**Live verification (Step 7, 2026-11-19) — the gate item above is
now CLOSED.** The install was run end-to-end on macf-server in an
isolated Compose project (unique name, ports remapped off
production's): all three services boot and answer (gateway
liveliness 200 + model groups registered, Vikunja UI/API 200,
engine standalone loop up). The run found three draft defects,
all fixed in the tree with tests extended to pin them
(dockerInstall AC6/AC7/AC8): (1) production code required
`js-yaml` (and axios, https-proxy-agent, @slack/web-api) without
declaring them — the image's `npm ci --omit=dev` pruned js-yaml
(it existed only as a dev-transitive hoist) and the engine
crash-looped; all four are now declared runtime dependencies at
their lockfile versions. (2) Vikunja's current image runs as uid
1000 with no root init, so fresh root-owned volumes crash-looped
it — first the files dir, then its SQLite path /db; a
`vikunja-init` chown service and a `vikunja-db` volume were
added. (3) Current LiteLLM refuses to start without a master
key; the gateway now reads the stack's one secrets file
(`slack-agents/.env`, which must set `LITELLM_MASTER_KEY` —
added to `.env.example` and the README steps). Production was
not touched (engine/gateway PIDs and the Postiz set identical
before/after; the verify project was torn down with `down -v`).

**Acceptance criteria:**

1. Given a clean checkout, When an operator follows the README's
   Docker section, Then the steps are: copy `slack-agents/.env.example`
   to `slack-agents/.env` and fill it in, create the `instance/`
   directory, and run `docker compose up -d` — and every file and
   directory those steps name exists in the tree or is created by the
   step itself.
2. Given `docker-compose.yml`, When it is parsed as YAML, Then it is
   valid and defines the services `engine`, `gateway`, and `vikunja`,
   plus `ollama` under the `local-models` profile.
3. Given the compose file and the Dockerfile, When their referenced
   paths are checked against the tree, Then the build context, the
   Dockerfile, the gateway config mount source
   (`gateway/litellm_config.yaml`), and the engine's entry point
   (`slack-agents/engine/runStandalone.js`) all exist, and the
   Dockerfile installs from the committed lockfiles
   (`slack-agents/package-lock.json`, `hands/package-lock.json`).
4. Given the compose file, When its engine service is inspected,
   Then it sets `SPOKBOT_INSTANCE_DIR` and `SPOKBOT_STATE_DIR` to
   mounted paths (not image-internal defaults), reads secrets from
   `slack-agents/.env` via `env_file`, and publishes no port for the
   engine (it is a worker, not a server); the gateway publishes
   4000 and Vikunja publishes 3456, matching the ports production
   uses.
5. Given the README, When a reader searches it for the Docker
   install, Then the section names the same services, the same env
   file, and the same one command as the compose file — docs and
   files cannot drift apart without the smoke test failing.
