# @ppos/preflight-service - Hardened v2.2
FROM node:20-bookworm-slim AS builder

# Install system dependencies for build stage if needed
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 build-essential \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# 1. Stage and pack internal dependencies
# Note: These must be present in the build context (root)
COPY ppos-preflight-engine ./ppos-preflight-engine
COPY ppos-shared-infra ./ppos-shared-infra
COPY ppos-shared-contracts ./ppos-shared-contracts
# COPY ppos-core-platform ./ppos-core-platform # Use if needed

RUN cd ppos-preflight-engine && npm pack && mv *.tgz ../engine.tgz
RUN cd ppos-shared-infra && npm pack && mv *.tgz ../infra.tgz
RUN cd ppos-shared-contracts && npm pack && mv *.tgz ../contracts.tgz
# RUN cd ppos-core-platform && npm pack && mv *.tgz ../platform.tgz

# 2. Prepare the service
WORKDIR /app
COPY ppos-preflight-service/package*.json ./
COPY --from=builder /build/*.tgz ./

# Patch package.json to use tarballs
RUN sed -i 's|"file:../ppos-preflight-engine"|"file:./engine.tgz"|g' package.json
RUN sed -i 's|"file:../ppos-shared-infra"|"file:./infra.tgz"|g' package.json
RUN sed -i 's|"file:../ppos-shared-contracts"|"file:./contracts.tgz"|g' package.json

# Clean install
RUN npm install --only=production --no-audit

# 3. Final Production Stage
FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ghostscript \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=builder /app ./
# Normalize contract location by extracting the tarball
RUN mkdir -p ppos-shared-contracts && \
    tar -xzf contracts.tgz -C ppos-shared-contracts --strip-components=1 && \
    rm contracts.tgz
COPY ppos-preflight-service/ ./

ENV NODE_ENV=production
ENV PPOS_SERVICE_PORT=8001
ENV GS_COMMAND=gs
ENV PPOS_TEMP_DIR=/tmp/ppos-preflight

EXPOSE 8001
CMD ["node", "server.js"]
