# @ppos/preflight-service Dockerfile
FROM node:20-bookworm-slim

# Install system dependencies (Ghostscript is required as engine is bundled)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ghostscript \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Satisfy local dependencies (Copied into external context for isolation)
COPY ppos-preflight-engine ./ppos-preflight-service/libs/ppos-preflight-engine
COPY ppos-shared-infra ./ppos-preflight-service/libs/ppos-shared-infra
COPY ppos-shared-contracts ./ppos-preflight-service/libs/ppos-shared-contracts

# Setup service
WORKDIR /app/ppos-preflight-service
COPY ppos-preflight-service/package.json ./
RUN npm install --only=production --no-audit --install-links

COPY ppos-preflight-service ./

# Environment configuration
ENV PPOS_SERVICE_PORT=8001
ENV GS_COMMAND=gs
ENV PPOS_TEMP_DIR=/tmp/ppos-preflight

EXPOSE 8001

CMD ["node", "server.js"]
