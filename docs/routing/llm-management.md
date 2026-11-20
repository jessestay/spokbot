# MACF LLM Management — Local Tier Runtimes & Routing

**Date:** 2026-10-22
**Status:** Production on macf-server (Oracle), gateway `macf-gateway` (LiteLLM, :4000)

## (a) The feature

MACF's local inference tiers are **runtime-swappable**. The gateway does not
hard-code a local inference engine: each local tier is served by a pluggable
runtime, and switching runtimes is a config change, not a code change.

Supported local runtimes:

| Runtime | Where it runs | Protocol | Current role |
|---|---|---|---|
| **LM Studio** | Jesse's desktop (GTX 980 GPU) | OpenAI-compatible (`/v1`) | Tier 1 (primary local) |
| **Ollama** | macf-server (Oracle, CPU) | Ollama native (`/api`) via LiteLLM `ollama/` provider | Tier 2 (always-on backup local) |

Downstream of the local tiers, the gateway continues to the OpenRouter legs
(free, then paid) and direct paid APIs exactly as before; LLM management only
governs the local tiers.

## (b) How a tier's runtime is chosen

Two environment variables in `gateway/gateway.env` (loaded by the
`macf-gateway` systemd unit) name the runtimes:

- `LOCAL_DESK_URL` — base URL of the desktop runtime
  (currently `https://llm.staynalive.com/v1`, LM Studio).
- `LOCAL_DESK_KEY` — API key for the desktop runtime (LM Studio ignores it;
  LiteLLM's `openai/` provider requires one to be present).
- `OLLAMA_URL` — base URL of the server Ollama
  (currently `http://127.0.0.1:11434`).

`gateway/litellm_config.yaml` wires those into model groups:

- `macf-local-desk` — Tier 1 deployment: `openai/qwen2.5-3b-instruct`
  via `LOCAL_DESK_URL` / `LOCAL_DESK_KEY`, timeout 20s.
- `macf-local-srv` — Tier 2 deployment: `ollama/qwen2.5:3b-instruct-q4_K_M`
  via `OLLAMA_URL`, timeout 30s.
- `macf-local-srv-llama` — Tier 2 for `macf-local`:
  `ollama/llama3.2:3b` via `OLLAMA_URL`, timeout 120s.

Every local-serving group (`macf-cheap`, `macf-classify`, `macf-mid`,
`macf-smart`, `macf-local`, and the legacy aliases `macf-smart-or` /
`macf-frontier-or`) carries the **desk deployment as its own first
deployment** and chains through `router_settings.fallbacks` to the server
tier, then to its original downstream fallback (e.g. `macf-smart` →
`macf-local-srv` → `macf-smart-free`).

**To switch a tier's runtime:**

1. Edit `gateway/gateway.env` (point `LOCAL_DESK_URL` / `OLLAMA_URL` at the
   new runtime) and/or the group's `litellm_params` in
   `gateway/litellm_config.yaml` (model + provider prefix). Back up both
   files first (timestamped copies in the same directory).
2. `sudo systemctl restart macf-gateway`
3. Run the probe set: `POST http://127.0.0.1:4000/v1/chat/completions` with
   the gateway master key for **every** model group, and confirm real
   completions. If any previously-working group regresses, restore the
   backups, restart, and re-probe.

## (c) Current production topology (2026-10-22)

| Tier | Runtime | Model | Route | Measured speed |
|---|---|---|---|---|
| Tier 1 | LM Studio (desktop, GTX 980) | `qwen2.5-3b-instruct` (resident) | `https://llm.staynalive.com/v1` via Cloudflare Tunnel | 24–29 tok/s |
| Tier 2 | Ollama (macf-server) | `qwen2.5:3b-instruct-q4_K_M`, `llama3.2:3b` | `http://127.0.0.1:11434` | 14.8 tok/s |
| Downstream | OpenRouter free → paid → direct APIs | (unchanged) | via gateway fallback chain | — |

Desktop tier notes:

- A Cloudflare WAF rule allows **only the server's public IP
  (129.146.109.49)** to reach `llm.staynalive.com`; the tunnel endpoint is
  not publicly usable.
- Desktop boot tasks `LMStudio-ServeLoad` (starts the LM Studio server and
  loads the model) and `Cloudflared-MACF-LLM` (starts the tunnel) keep the
  tier alive across reboots.
- The 4 GB GTX 980 holds **one** 3B model at full speed, so only
  `qwen2.5-3b-instruct` is resident on the desktop. `llama3.2-3b` lives on
  Tier 2 (server Ollama), which preserves model diversity: `macf-local`
  tries the desktop Qwen first and the server Llama second, by design.
- If the desktop is off or unreachable, the desk deployment times out
  (20 s) and every local group falls through to Tier 2 automatically.

## (d) Routing policy

- **Local is the default** for cheap / classification / simple work
  (`macf-cheap`, `macf-classify`, `macf-mid`): free, fast, private.
- **Local is the first attempt and the last-resort fallback** for the smart
  groups (`macf-smart`, `macf-local`): they try local first, escalate to
  the OpenRouter legs for real capability, and the chain's tail
  (`macf-best-direct`) loops back to `macf-cheap` so a local answer exists
  even when every paid/free upstream is down.
- **Capable hosted models remain the default for agent reasoning**
  (`macf-smart-paid`, `macf-best`): a 3B local model does not do the team's
  heavy thinking; local tiers exist for cost control, latency, and
  survivability — not as a capability substitute.

## (e) Canary

`gateway/local-canary.sh` probes `macf-cheap` and `macf-local` through the
gateway and appends `ISO-timestamp group OK|FAIL latency` lines to
`gateway/canary.log`. It runs hourly via the systemd timer
`macf-local-canary.timer` (service: `macf-local-canary.service`), enabled
2026-10-22. First entries:

```
2026-10-22T10:11:07Z macf-cheap OK 0.546209s
2026-10-22T10:11:07Z macf-local OK 0.297949s
```

A FAIL line means both local tiers failed to answer through the gateway —
check the desktop tunnel/LM Studio first, then server Ollama.

## (f) Change history

- **2026-10-22** — Local tier restructured per Jesse's order ("Chain both:
  desktop first, Oracle second"). Ollama was **removed from the desktop in
  favor of LM Studio** (Ollama's current builds no longer offload to the
  GTX 980's Maxwell architecture; LM Studio does — 24–29 tok/s vs 5.5 tok/s
  CPU-only under Ollama 0.40.8). Ollama remains the server-side Tier 2
  runtime. Pre-change backups: `gateway/litellm_config.yaml.bak-20261022-100624`,
  `gateway/gateway.env.bak-20261022-100624`. All 13 pre-existing gateway
  groups probed OK before and after the change (macf-smart-free's
  reasoning-model behavior at tiny token budgets is unchanged pre-existing
  behavior; it produces content at normal budgets).
