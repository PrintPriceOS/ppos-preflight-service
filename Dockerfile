# @ppos/preflight-service - Hardened v2.4
# Multi-stage build for clean production images

# Stage 1: Build & Pack internal dependencies
FROM node:20-bookworm-slim AS builder

WORKDIR /build
COPY ppos-preflight-engine ./ppos-preflight-engine
COPY ppos-shared-infra ./ppos-shared-infra
COPY ppos-shared-contracts ./ppos-shared-contracts

RUN cd ppos-preflight-engine && npm pack && mv *.tgz ../engine.tgz
RUN cd ppos-shared-infra && npm pack && mv *.tgz ../infra.tgz
RUN cd ppos-shared-contracts && npm pack && mv *.tgz ../contracts.tgz

# Stage 2: Prepare & Install Service
FROM node:20-bookworm-slim AS installer

WORKDIR /app
COPY ppos-preflight-service/package*.json ./
COPY --from=builder /build/*.tgz ./

RUN sed -i 's|"file:../ppos-preflight-engine"|"file:./engine.tgz"|g' package.json && \
    sed -i 's|"file:../ppos-shared-infra"|"file:./infra.tgz"|g' package.json && \
    sed -i 's|"file:../ppos-shared-contracts"|"file:./contracts.tgz"|g' package.json

RUN npm install --omit=dev --no-audit

# Stage 3: Final Production Runtime
FROM node:20-bookworm-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends ghostscript && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Bring in installed deps + patched metadata
COPY --from=installer /app ./

# Bring in service source
COPY ppos-preflight-service/ ./

# Restore patched package.json so runtime metadata stays aligned
COPY --from=installer /app/package.json ./package.json

ENV NODE_ENV=production
ENV PPOS_SERVICE_PORT=8001
ENV GS_COMMAND=gs
ENV PPOS_TEMP_DIR=/tmp/ppos-preflight

EXPOSE 8001
CMD ["node", "server.js"]
