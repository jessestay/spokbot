# Spokbot

**The open-source AI team that verifies its own work. Your models, your machine, your team.**

Spokbot (formerly the Multi-Agent Communications Framework, MACF) is a 24/7 AI executive team that runs real business operations on your own infrastructure — and is only allowed to call something done when the outcome verifies at the source.

Spokbot is a persistent team of named AI agents with real roles that works around the clock the way a staffed company would: work is assigned as tickets, executed by the responsible agent, receipted, and audited against verified outcomes. You are the chairman. You make only the decisions only you can make; the team does the rest, and proves it. The same team — same personalities, memory, and skills — meets you on Slack, in Cursor, in Claude Desktop, or in any MCP-compatible assistant.

**Why Spokbot:**

- **Open source + self-hosted.** Apache-2.0. Spokbot runs on your machine, under your control — no bundled subscription, no cloud computer you have to rent back from a vendor.
- **LLM-agnostic + local-first.** Bring your own models: local models (Ollama by default; llama.cpp, SGLang, vLLM, and Mia's AI Lab recipes for bigger hardware), subscription AI apps, OpenRouter, or direct provider APIs. Routing is budget-first — cheap work defaults to local models, reasoning defaults to the most capable model you have connected. Swap or add models without touching the team's roles, memory, or tools. A zero-API-budget instance still runs on local models alone. (A staged local-first routing profile lives in `slack-agents/config/models.local-first.example.yaml`.)
- **Repeats.** Standing loops that do the recurring work: scheduled agent routines, per-agent or team-wide, optionally emulating a named expert's framework (a Lou Adler lens for hiring, a Neil Patel lens for SEO, and other expert lenses wired into the roles). Repeats are data — clone them to new roles, sites, and businesses.
- **MCP-native, extensible by configuration.** Tools arrive as MCP servers through a grants system: a baseline set unioned into every agent, role grants on top, and gated tools (payments, desktop control, finance) behind explicit owner decisions. Adding capability means granting an MCP server, building a custom MCP tool, or adding a skill or an action — never rebuilding the team.
- **Accountability you can audit.** Agents cannot mark their own work done. Every tool call writes a receipt, a task closes only when its postconditions verify, and a recurring outcome audit counts only verified deliveries: a portal confirmation, a live URL, a changed page, a send reference. Activity is not delivery.
- **Managed like a real scrum team.** Every unit of work is a user story ("As a ...") with acceptance criteria and a difficulty score, built BDD-first, then TDD, with automated tests running on a schedule.
- **Owner-controlled.** Nothing external — a send, a post, a purchase, a filing — happens outside your approval rules. It runs on your infrastructure (a free-tier instance is enough), so your data, your memory, and your audit trail stay yours.

The full definition — every function, the outcome that counts for each, and the verification standard the system is audited against — lives in [MACF-DEFINITION-AND-VERIFICATION-SPEC.md](MACF-DEFINITION-AND-VERIFICATION-SPEC.md).

---

## The Team

- **CEO** — runs the company day to day, verifies the team's work, and brings the chairman only the decisions that are his
- **Exec PM** — routing and coordination across the team
- **CTO** — engineering, infrastructure, tooling
- **CMO** — marketing strategy, campaigns, social content
- **CCO** — content drafting (always for your review, never auto-publishes)
- **CRO** — research, competitive intelligence, trends
- **CFO** — financial tracking, metrics, strategy (not a CPA)
- **Lawyer** — legal risk, contracts, compliance (guidance only, not representation)
- **Job Coach** — executive job search strategy, pipeline, applications
- **SEO Expert** — search and AI-visibility audits turned into changed pages
- **CUXO** — UX/design review, accessibility audits

---

## Architecture

The kernel is one tree; instance data (personas, config, state)
lives outside it and is mounted in at runtime
(`SPOKBOT_INSTANCE_DIR` / `SPOKBOT_STATE_DIR`), so the same
framework serves any operator's team.

- **`slack-agents/`** — the production engine: Slack app (Bolt
  Socket Mode), directive intake, delegation, the LLM tool loop,
  MCP tool execution under grants, durable memory and
  checkpointing, and postcondition verification.
- **`gateway/`** — the LiteLLM gateway: one OpenAI-compatible
  endpoint in front of every model leg (local Ollama, provider
  APIs, subscription bridges), with the routing/fallback contract
  in `gateway/litellm_config.yaml` and a local-tier canary probe.
- **`hands/`** — the MCP servers the engine spawns (first-party
  servers plus configured third-party ones), granted per role
  through `hands/grants.example.json` — the capability baseline
  every agent inherits, with role grants on top.
- **`x-mcp/`** — the X (Twitter) MCP server the grants run.
- **`supervision/`** — the watchdog shell layer: liveness,
  token-health, and backup checks whose own invariants are
  test-pinned (a dead watchdog must never fail silently).
- **`stories/` + `tests/`** — the story registry's working docs
  and the framework suites (story/linkage lints, config
  contracts, spawn smoke) that keep the kernel honest.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full design.

---

## Quick Start

### Prerequisites
- Node.js 20+ (the Docker image uses Node 24), or Docker with Compose
- An LLM backend of your choice: a local model server (Ollama by default), an OpenRouter key, a provider API key, or a subscription AI app — wired through the gateway (see Model Routing)

### Run the Slack Bot

```bash
git clone https://github.com/jessestay/spokbot.git
cd spokbot/slack-agents
cp .env.example .env   # fill in SLACK_BOT_TOKEN, SLACK_APP_TOKEN, and your model keys
npm ci
npm start              # node index.js — the Slack app (Socket Mode)
```

The standalone engine loop (what production and the Docker image
run) is `node engine/runStandalone.js` from the same directory.

> The GitHub repo was renamed from `multiagentcommsframework` to `spokbot` on 2026-11-19 (Step 6), after the credential history purge completed and verified; the old URL redirects here.

### Run with Docker (one command)

The Compose stack runs the same three pieces production runs — the
**engine** (`slack-agents/engine/runStandalone.js`), the **gateway**
(a self-hosted LiteLLM proxy on port 4000, configured by
`gateway/litellm_config.yaml`), and **vikunja**, the task board the
engine works from (port 3456) — plus your **instance** directory,
mounted from `./instance` so your personas, config, and data live
outside the image and survive rebuilds.

```bash
cp slack-agents/.env.example slack-agents/.env   # fill in SLACK_BOT_TOKEN and your model keys
mkdir -p instance
docker compose up -d
```

One first-run step remains: open vikunja at
<http://localhost:3456>, create the owner account and an API token,
put the token in `slack-agents/.env` as `VIKUNJA_TOKEN`, then run
`docker compose restart engine`. Until then the engine container
stays up and logs exactly what is unconfigured — nothing fails
silently. Secrets come only from `slack-agents/.env`; no credential
is ever baked into the image or the Compose file. That file must
also set `LITELLM_MASTER_KEY` (any `sk-…` value you generate —
`slack-agents/.env.example` shows how): the gateway reads the
same file, and current LiteLLM refuses to start without a
master key.

For local models, add the optional Ollama service:
`docker compose --profile local-models up -d` (port 11434), matching
the staged local-first routing profile.

> Status: **live-verified 2026-11-19** (story US-FW-005, Step 7
> gate). The one-command install was run end-to-end on a clean
> host (isolated project, remapped ports): all three services
> boot and answer — the gateway's liveliness endpoint returns
> 200 with the model groups registered, vikunja serves its UI
> and API, and the engine starts its standalone loop. The live
> run found and fixed three draft defects (an undeclared
> production dependency the image pruned, vikunja's first-run
> volume ownership + database path, and the gateway's master-key
> wiring); the Compose file is additionally covered by
> structural smoke tests (`tests/dockerInstall.test.mjs`).

### MCP tools (hands/)

The team's tools are MCP servers, granted per role and spawned by
the engine — there is no separate adapter to install. The shipped
grant shape is `hands/grants.example.json`: a capability baseline
unioned into every agent, role grants on top, and gated servers
(payments, desktop control, finance) behind explicit owner
decisions. To add a tool, add its server to your instance's
`hands/grants.json` and grant it to the roles that should hold it.
The same MCP servers can also be pointed at any MCP-compatible
client (Cursor, Claude Code, Claude Desktop) directly — each
server under `hands/servers/` runs standalone over stdio.

See [SETUP.md](SETUP.md) for the full setup guide.

---

## Model Routing

All model traffic goes through the gateway (`gateway/`, a
self-hosted LiteLLM proxy on port 4000): the engine calls model
*groups* (`macf-cheap`, `macf-local`, `macf-smart`, …), and
`gateway/litellm_config.yaml` maps each group to its legs —
local Ollama models, provider APIs, subscription bridges — with
fallbacks between them. Adding or swapping a model is a gateway
config change, never a code change. A local-first profile
(`slack-agents/config/models.local-first.example.yaml`) routes
the default tiers to local models so a zero-API-budget instance
still runs. API keys live only in environment variables — the
committed gateway config references them as `os.environ/…`,
never as literals (a contract the test suites pin).

---

## Memory and State

Agents keep durable memory and checkpoints on disk, inside the
instance and state directories (`SPOKBOT_INSTANCE_DIR` /
`SPOKBOT_STATE_DIR`) — never inside the framework tree — so the
team's memory survives restarts and framework upgrades, and one
framework checkout can serve any instance by mounting a different
directory.

---

## CI / Quality

- **Framework suites** — `node --test tests/` at the repo root:
  the story-registry and linkage lints, instance-path and
  hardcoded-path sweeps, gateway config contracts, MCP spawn
  smoke, supervision-shell invariants, and the Docker install
  smoke tests.
- **Engine suites** — `npm test` in `slack-agents/` (jest).
- **Status dashboard** — [site/status.html](site/status.html) is
  generated from the story registry by the repo's own lints
  (`node site/build-status.mjs`); its counts are computed, never
  hand-written.

---

## Environment Variables

The engine reads `slack-agents/.env` (copy
`slack-agents/.env.example` and fill in your own values):

| Variable | Purpose |
|---|---|
| `SLACK_BOT_TOKEN` | Slack bot token (`xoxb-…`) |
| `SLACK_SIGNING_SECRET` | Slack app signing secret |
| `SLACK_APP_TOKEN` | Slack app-level token (`xapp-…`, Socket Mode) |
| `ANTHROPIC_API_KEY` | Anthropic API key (one of several model legs the gateway can route) |
| `GITHUB_TOKEN` | GitHub token for the team's repo access |
| `VIKUNJA_URL` / `VIKUNJA_TOKEN` | The Vikunja task board the engine works from |
| `SPOKBOT_INSTANCE_DIR` / `SPOKBOT_STATE_DIR` | Where instance data and runtime state live (set by the Compose file in Docker installs) |

---

## Roadmap

Built-and-verified is claimed only for what is above. These are
planned, in deliberate order, and labeled as roadmap until they
ship with tests:

- **Promotion** — public launch is held until the kernel
  verification program (see the definition spec) reports green
  across the board.
- **Repeats, deepened** — a resource governor for standing loops,
  a learning ledger of actions and conversions, and
  champion/challenger persona swaps decided only on tracked wins.
- **More platform surfaces** — the same team on Discord and
  Microsoft Teams (Slack is the shipped surface today), and a
  hosted MCP endpoint so external MCP clients can meet the team
  without a local checkout.
- **TensorFlow senses layer** — perception inputs (image/audio
  classification) feeding the team's context, alongside the
  Mia's AI Lab certified local-model catalog as the model's
  recipe source.

---

## License

Apache-2.0 — free to use, modify, and run your own instance. See [LICENSE](LICENSE).

## Author

Built by [Jesse Stay](https://staynalive.com). Contributions welcome — see [ARCHITECTURE.md](ARCHITECTURE.md) for how the pieces fit together.
