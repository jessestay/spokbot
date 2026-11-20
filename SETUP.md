# Setup Guide

Everything you need to run Spokbot — the Docker stack (fastest), a manual
Slack-app install, the Slack app itself, and the MCP tool servers.

---

## 1. Clone & Configure

```bash
git clone https://github.com/jessestay/spokbot.git
cd spokbot
cp slack-agents/.env.example slack-agents/.env
```

The stack's one secrets file is `slack-agents/.env`. Fill in at least:

```env
# Required for the Slack surface
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
SLACK_SIGNING_SECRET=...

# Required by the gateway (any sk-… value you generate)
LITELLM_MASTER_KEY=sk-...

# Model providers — only the legs you enable in gateway/litellm_config.yaml
ANTHROPIC_API_KEY=sk-ant-...

# Filled in after the Vikunja first-run step (Docker path, §2)
VIKUNJA_URL=http://vikunja:3456
VIKUNJA_TOKEN=
VIKUNJA_PROJECT_ID=
```

No credential is ever baked into an image, the Compose file, or the
gateway config — the gateway reads keys only as `os.environ/` references
into this file.

---

## 2. Run with Docker (one command)

The Compose stack runs the same three pieces production runs — the
**engine** (`slack-agents/engine/runStandalone.js`), the **gateway**
(a self-hosted LiteLLM proxy on port 4000, configured by
`gateway/litellm_config.yaml`), and **Vikunja**, the task board the
engine works from (port 3456) — plus your **instance** directory,
mounted from `./instance` so your personas, config, and data live
outside the image and survive rebuilds.

```bash
mkdir -p instance
docker compose up -d
```

One first-run step remains: open Vikunja at <http://localhost:3456>,
create the owner account and an API token, put the token in
`slack-agents/.env` as `VIKUNJA_TOKEN`, then run
`docker compose restart engine`. Until then the engine container stays
up and logs exactly what is unconfigured — nothing fails silently.

For local models, add the optional Ollama service:
`docker compose --profile local-models up -d` (port 11434), matching
the staged local-first routing profile.

> Status: **live-verified 2026-11-19** (story US-FW-005). The
> one-command install was run end-to-end on a clean host: all three
> services boot and answer — the gateway's liveliness endpoint returns
> 200 with the model groups registered, Vikunja serves its UI and API,
> and the engine starts its standalone loop.

---

## 3. Slack App Setup

### Create the Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From scratch**
2. Name it (e.g. "Spokbot"), pick your workspace
3. **Socket Mode** (left sidebar) → Enable Socket Mode → Generate an App-Level Token with `connections:write` scope → this is your `SLACK_APP_TOKEN` (`xapp-...`)
4. **OAuth & Permissions** → Bot Token Scopes — add:
   - `app_mentions:read`
   - `chat:write`
   - `channels:history`
   - `groups:history`
   - `im:history`
   - `mpim:history`
   - `channels:read`
   - `groups:read`
5. **Install App to Workspace** → copy the Bot User OAuth Token → this is your `SLACK_BOT_TOKEN` (`xoxb-...`)
6. **Event Subscriptions** → Enable Events → Subscribe to bot events: `app_mention`, `message.channels`
7. **Basic Information** → copy the Signing Secret → this is your `SLACK_SIGNING_SECRET`

### Invite the Bot to Your Channels

Spokbot's channel layout is one channel per function (management,
marketing, research, content, jobs, cto in the reference instance —
your instance defines its own). In each channel the team should work in:

```
/invite @YourBotName
```

The lead agent posts to the management channel and listens for
@mentions and directives in the channels it belongs to.

### Remove Old/Duplicate Bots

If a stale bot from an earlier install is still connected, it will
answer the same messages and create confusing duplicates:

1. Go to **Slack workspace settings** → **Manage apps**
2. Find the old app → **Remove app**

Only one app should be running against a workspace at a time.

---

## 4. Run Manually (without Docker)

Prerequisites: Node.js 20+ (the Docker image uses Node 24).

```bash
cd slack-agents
cp .env.example .env   # if you haven't already
npm ci
npm start              # node index.js — the Slack app (Socket Mode)
```

The standalone engine loop (what production and the Docker image run)
is, from the same directory:

```bash
node engine/runStandalone.js
```

Run the tests:

```bash
node --test tests/           # framework suite, from the repo root
cd slack-agents && npx jest  # engine suites
```

---

## 5. MCP Tool Servers (hands/)

The tool servers in `hands/servers/` (Slack, finance, desktop,
LinkedIn, …) speak standard MCP over stdio and can be used by the
engine or by any external MCP client (Cursor, Claude Code, Claude
Desktop, …).

```bash
cd hands && npm ci
```

Which agent roles may call which tools is governed by grants:
`hands/grants.json` in a deployed tree, with `hands/grants.example.json`
shipping the framework defaults. A deployed tree missing its
`grants.json` logs a loud deployment-defect warning at startup rather
than silently running on defaults. See `hands/ARCHITECTURE.md` and
`hands/INVENTORY.md` for the server-by-server details.

---

## 6. Model Routing

The engine never calls a model vendor directly. It addresses **model
groups** in the gateway (`gateway/litellm_config.yaml`), and each
group is an ordered list of legs — a local Ollama model, a free tier,
a paid API — with fallbacks. To change providers, edit the group
configuration and the keys in `slack-agents/.env`; no agent code
changes. See the Model Routing section of `ARCHITECTURE.md`.

---

## 7. Deployment Notes

- **Docker** (§2) is the supported self-host path.
- The reference production deployment runs the standalone engine loop
  under systemd on a single host, with the gateway and Vikunja as
  sibling services and the `supervision/` watchdog scripts watching
  the watcher.
- State is on-disk files in the instance directory
  (`SPOKBOT_INSTANCE_DIR` / `SPOKBOT_STATE_DIR`) — back up that
  directory and you have backed up the team.

---

## 8. Troubleshooting

**Bot not responding in Slack**
- Verify `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` are set correctly in `slack-agents/.env`
- Confirm Socket Mode is enabled on the app
- Make sure the bot is invited to the channel you're messaging in
- Check the engine log — an unconfigured dependency (e.g. Vikunja) is logged by name, not hidden

**Gateway refuses to start**
- Current LiteLLM requires a master key: set `LITELLM_MASTER_KEY` in `slack-agents/.env` (§1)

**Engine warns about missing grants.json**
- A deployed tree needs its own `hands/grants.json`; the fallback to `grants.example.json` is a deployment defect warning, not a supported mode (§5)

**Duplicate bot responses**
- Two Slack apps are running against the same workspace — remove the stale one (§3)

**Delegation lines visible in messages (`[from: X → Y]`)**
- Those headers are the engine's internal routing; if they appear in an owner-facing relay, that's a defect — please file an issue with the receipt ID from the message
