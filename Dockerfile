# Spokbot kernel image (draft — US-FW-005).
# Layout mirrors production: slack-agents/ is the engine tree, hands/
# holds the MCP servers it spawns. Instance data and state are NEVER
# baked in — they arrive through SPOKBOT_INSTANCE_DIR /
# SPOKBOT_STATE_DIR mounts (see docker-compose.yml).
FROM node:24-slim

WORKDIR /app

# Install from the committed lockfiles first, so dependency layers
# cache independently of source changes.
COPY slack-agents/package.json slack-agents/package-lock.json ./slack-agents/
COPY hands/package.json hands/package-lock.json ./hands/
RUN cd slack-agents && npm ci --omit=dev \
 && cd ../hands && npm ci --omit=dev

COPY . .

WORKDIR /app/slack-agents
CMD ["node", "engine/runStandalone.js"]
