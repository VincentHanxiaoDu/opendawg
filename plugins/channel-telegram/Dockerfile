FROM node:22-slim

# node-pty requires build tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ curl procps ca-certificates ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy plugin source
COPY . .

RUN npm install --legacy-peer-deps && npm rebuild better-sqlite3 && npm run build:prod

# Health check: verify the node process is running
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
    CMD pgrep -f "node.*dist/app" || exit 1

# Skip cli.js (demands .env on disk); app.js reads env vars directly
CMD ["node", "dist/app.js"]
