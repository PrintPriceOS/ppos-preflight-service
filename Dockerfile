# @ppos/preflight-service - Hardened v2.3
# Multi-stage build for clean production images

# Stage 1: Build & Pack internal dependencies
FROM node:20-bookworm-slim AS builder

WORKDIR /build
# These must be present in the umbrella root build context
COPY ppos-preflight-engine ./ppos-preflight-engine
COPY ppos-shared-infra ./ppos-shared-infra
COPY ppos-shared-contracts ./ppos-shared-contracts

RUN cd ppos-preflight-engine && npm pack && mv *.tgz ../engine.tgz
RUN cd ppos-shared-infra && npm pack && mv *.tgz ../infra.tgz
RUN cd ppos-shared-contracts && npm pack && mv *.tgz ../contracts.tgz

# Stage 2: Prepare & Install Service
WORKDIR /app
COPY ppos-preflight-service/package*.json ./
COPY --from=builder /build/*.tgz ./

# Patch package.json with the generated tarballs
RUN sed -i 's|"file:../ppos-preflight-engine"|"file:./engine.tgz"|g' package.json && \
    sed -i 's|"file:../ppos-shared-infra"|"file:./infra.tgz"|g' package.json && \
    sed -i 's|"file:../ppos-shared-contracts"|"file:./contracts.tgz"|g' package.json

# Production install - ignores devDeps and uses clean state
RUN npm install --only=production --no-audit

# Stage 3: Final Production Runtime
FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y ghostscript && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app
# 1. Bring in pre-installed node_modules and patched package.json metadata
COPY --from=builder /app ./

# 2. Bring in source code
# Note: This overwrites package.json with the local copy. We'll fix it in the next step.
COPY ppos-preflight-service/ ./

# 3. Restore the patched package.json to ensure runtime metadata consistency 
# so 'npm list' and other tools see the correct tarball references.
COPY --from=builder /app/package.json ./package.json

ENV NODE_ENV=production
ENV PPOS_SERVICE_PORT=8001
ENV GS_COMMAND=gs
ENV PPOS_TEMP_DIR=/tmp/ppos-preflight

EXPOSE 8001
CMD ["node", "server.js"]
