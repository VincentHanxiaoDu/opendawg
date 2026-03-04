FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ curl procps ca-certificates ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy channel-core first and build it
COPY packages/channel-core/ packages/channel-core/

# Copy plugin source
COPY plugins/channel-discord/ plugins/channel-discord/

# Create a minimal root package.json for npm workspaces
RUN echo '{"private":true,"workspaces":["packages/channel-core","plugins/channel-discord"]}' > package.json

# Install all workspace dependencies and build
RUN npm install --legacy-peer-deps \
    && cd packages/channel-core && npm run build && cd ../.. \
    && cd plugins/channel-discord && npm rebuild better-sqlite3 && npm run build:prod

WORKDIR /app/plugins/channel-discord

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
    CMD pgrep -f "node.*dist/app" || exit 1

CMD ["node", "dist/app.js"]
