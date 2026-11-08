# ---- build the React frontend ----
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- runtime: Node server + Claude Code CLI ----
FROM node:24-slim
ARG CLAUDE_CODE_VERSION=latest
# Tools the agent commonly reaches for inside the workspace.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ripgrep python3 ca-certificates curl procps \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
 && npm cache clean --force

WORKDIR /app
COPY --from=build /app/dist ./dist
COPY server.ts ./
COPY src/types.ts ./src/types.ts
COPY replays ./replays
COPY package.json ./

# Run as the non-root `node` user (uid 1000); its ~/.claude holds login + sessions.
RUN mkdir -p /workspace /home/node/.claude && chown -R node:node /workspace /home/node /app
USER node
ENV IN_CONTAINER=1 \
    HOST=0.0.0.0 \
    PORT=8787 \
    DEFAULT_CWD=/workspace
EXPOSE 8787
VOLUME ["/home/node/.claude"]
CMD ["node", "server.ts"]
