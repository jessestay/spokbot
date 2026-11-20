# Spokbot Architecture

**Spokbot** (formerly the Multi-Agent Communications Framework, MACF) — an
open-source, LLM-agnostic, local-first framework for running a persistent AI
team: agents with defined roles take directives in Slack, delegate to each
other, execute tools through MCP servers under per-role grants, and prove
their work with receipts and postcondition checks before anything is relayed
to the owner.

> **Accuracy note (Nov 2026):** this document describes the tree as it
> exists. The original layered `core/` + `adapters/` design was never built
> as drawn; the production engine is `slack-agents/`, and where any older
> document disagrees with this one, the tree itself is canonical. The
> framework/instance split has landed: this repo is the framework, and an
> operator's personas, channels, and state live in a separate instance
> directory (`SPOKBOT_INSTANCE_DIR` / `SPOKBOT_STATE_DIR`) mounted into it.

---

## Design Philosophy

Each part has one job and a checkable contract:

1. **Engine** (`slack-agents/`) — directive intake → delegation → tool
   execution → verification → relay. It owns the agent loop and nothing else.
2. **Gateway** (`gateway/`) — a self-hosted LiteLLM proxy. The engine never
   calls a model vendor directly; it calls gateway model groups, and the
   gateway owns routing, fallbacks, and keys. This is what makes Spokbot
   LLM-agnostic: swap the group configuration, not the agent code.
3. **Hands** (`hands/`) — MCP servers (Slack, finance, desktop, LinkedIn, …)
   plus the grants model that decides which agent roles may use which
   tools. The servers also run standalone over stdio for any MCP client.
4. **Verification** — every delegated result carries a receipt; the engine
   checks postconditions against primary sources before relaying. Stories
   in `stories/` carry BDD acceptance criteria and are lint-linked to the
   tests that prove them (`tests/`).

---

## Repository Layout

```
spokbot/
│
├── slack-agents/                 # The engine and the Slack app
│   ├── engine/                   # 24/7 standalone loop (runStandalone.js),
│   │                             # delegation, PM breakdown, supervision hooks
│   ├── agents/                   # One file per agent role (CEO, CMO, CTO,
│   │                             # CFO, lawyer, job coach, …)
│   ├── utils/                    # Model router, MCP client, grants loading,
│   │                             # state, Vikunja client, receipts
│   └── .env.example              # The stack's one secrets file template
│
├── gateway/                      # LiteLLM gateway configuration
│   └── litellm_config.yaml       # Model groups + fallbacks; keys are
│                                 # os.environ/ references, never literals
│
├── hands/                        # MCP servers + the grants model
│   ├── servers/                  # desktop, finance, finance-files,
│   │                             # linkedin, slack, …
│   ├── grants.example.json       # Shipped default role grants
│   └── package.json
│
├── x-mcp/                        # Experimental MCP probes/clients
├── supervision/                  # Watchdog scripts for a deployed engine
├── stories/                      # User stories (BDD) — the spec layer
├── tests/                        # Framework suite (node --test)
├── site/                         # spokbot.org site + generated status
│                                 # dashboard (build-status.mjs)
├── docs/                         # Design docs and runbooks
│
├── Dockerfile                    # Engine image
├── docker-compose.yml            # One-command stack: engine + gateway
│                                 # (port 4000) + vikunja (port 3456),
│                                 # optional Ollama profile (port 11434)
└── .github/workflows/pages.yml   # Publishes site/ to GitHub Pages
```

---

## How a Directive Flows

```
Owner → #management → lead agent
                          │ [from: CEO → CMO]   delegation header
                          ├──────────────────→ role agent processes,
                          │ [from: CEO → CRO]   tools via MCP under grants
                          └──────────────────→ role agent processes
                                                        │
Lead agent verifies ←──── receipts + postconditions ────┘
Owner sees one aggregated relay
```

Delegation lines (`[from: X → Y]`) are the engine's internal routing
headers; the relay the owner reads is the verified aggregate, not raw
agent chatter. A result that fails its postcondition check is not
relayed as done — it goes back as a defect.

## Model Routing

The engine addresses **model groups**, never vendors: e.g. a cheap/fast
group for classification, a smart group for reasoning, and local groups
backed by Ollama for the local-first profile. The gateway
(`gateway/litellm_config.yaml`) maps each group to an ordered list of
legs with fallbacks, so a local model, a free tier, or a paid API can
serve the same group. API keys appear in the config only as
`os.environ/` references; the values live in `slack-agents/.env`.

## MCP Tools and Grants

Tool access is capability-based:

- Each MCP server in `hands/servers/` exposes tools over stdio
  (JSON-RPC), usable by the engine or by any external MCP client.
- `hands/grants.json` (an instance file; `grants.example.json` ships the
  defaults) maps agent roles to the servers/tools they may invoke.
  Role grants only add to a baseline capability set — they never widen
  silently, and spend-capable or destructive tools stay gated behind
  explicit grants.
- A deployed tree that is missing its `grants.json` and silently falls
  back to the shipped example is treated as a deployment defect and
  logged loudly at process start.

## Memory and State

Agent state is on-disk files in the instance/state directories — no
external database, no hosted memory service. The framework reads its
instance location from `SPOKBOT_INSTANCE_DIR` / `SPOKBOT_STATE_DIR`,
which is what lets the same framework tree run a production instance, a
staging instance, and the Docker stack side by side without touching
each other's state.

---

## CI / Quality

- **Framework suite:** `node --test tests/` at the repo root — story
  lint, linkage lint (every story's acceptance criteria linked to real
  tests), capability baseline, Docker-install contract, status-dashboard
  checks, and more.
- **Engine suites:** jest, run inside `slack-agents/`.
- **GitHub Pages:** `.github/workflows/pages.yml` publishes `site/`
  (the project site and the generated status dashboard) on push to
  `main`.

There is no hosted CI smoke test against a live deployment: verification
runs against the deployment itself (receipts, supervision, outcome
audits), not against a staging replica of it.

---

## Environment Variables

The stack's one secrets file is `slack-agents/.env` (template:
`slack-agents/.env.example`). Principal entries:

| Variable | Purpose |
|---|---|
| `SLACK_BOT_TOKEN` | Slack bot OAuth token |
| `SLACK_APP_TOKEN` | Slack Socket Mode app-level token |
| `SLACK_SIGNING_SECRET` | Slack request signing secret |
| `ANTHROPIC_API_KEY` | One of several possible model-provider keys |
| `LITELLM_MASTER_KEY` | Gateway master key (required by current LiteLLM) |
| `VIKUNJA_URL` / `VIKUNJA_TOKEN` / `VIKUNJA_PROJECT_ID` | Task-board connection |
| `GITHUB_TOKEN` | GitHub access for the roles that need it |
| `NODE_ENV` | Runtime environment name |

Model-provider keys beyond these depend on which gateway legs an
operator enables; the gateway config names the env var each leg reads.

---

## Running Locally

```bash
# Slack app (Socket Mode)
cd slack-agents
cp .env.example .env   # fill in keys
npm ci
npm start

# Standalone engine loop (what production and Docker run)
node engine/runStandalone.js

# Or the whole stack in Docker
cp slack-agents/.env.example slack-agents/.env
mkdir -p instance
docker compose up -d

# Tests
node --test tests/          # from the repo root
cd slack-agents && npx jest # engine suites
```

See `SETUP.md` for the full setup walkthrough and `README.md` for the
quick start.

---

## Roadmap

- Promotion of the public site and README claims stays held until the
  kernel verification suite is green end-to-end.
- Discord and Teams surfaces, and a hosted MCP endpoint, alongside the
  Slack surface.
- A TensorFlow-based senses layer, with Mia's AI Lab model recipes
  (mia-ai.net/models) as the certified local-model catalog.

---

## Contributing

Apache-2.0. The discipline that keeps this tree honest: every feature
lands as a story in `stories/` ("As a …" + Given/When/Then + difficulty)
with tests written first, and the linkage lint fails the suite when a
story and its tests drift apart. PRs that keep that contract are warmly
welcomed.
