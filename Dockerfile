# @ppos/preflight-service Dockerfile
FROM node:20-bookworm-slim

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    ghostscript \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Step 1: Securely stage the GUARANTEED FRESH source code from the monorepo root
# This bypasses any nested, outdated 'libs' folders sneaking in from the host side
COPY ppos-preflight-engine ./staged-libs/ppos-preflight-engine
COPY ppos-shared-infra ./staged-libs/ppos-shared-infra
COPY ppos-shared-contracts ./staged-libs/ppos-shared-contracts

# Pack them into immutable tarballs
RUN cd staged-libs/ppos-preflight-engine && npm pack && mv *.tgz /app/engine.tgz
RUN cd staged-libs/ppos-shared-infra && npm pack && mv *.tgz /app/infra.tgz
RUN cd staged-libs/ppos-shared-contracts && npm pack && mv *.tgz /app/contracts.tgz

# Step 2: Bring in the service source code from the host
WORKDIR /app/ppos-preflight-service
COPY ppos-preflight-service ./

# Step 3: Purgatory - ANNIHILATE any host artifacts (node_modules, old libs) that leaked through broken .dockerignores
RUN rm -rf node_modules package-lock.json libs

# Step 4: Reroute package.json strictly to the mathematically perfect `.tgz` archives we built in Step 1
RUN sed -i -E 's|"file:.*ppos-preflight-engine"|"file:../engine.tgz"|g' package.json
RUN sed -i -E 's|"file:.*ppos-shared-infra"|"file:../infra.tgz"|g' package.json

# Step 5: Final pristine installation
RUN npm install --only=production --no-audit

# Environment configuration
ENV PPOS_SERVICE_PORT=8001
ENV GS_COMMAND=gs
ENV PPOS_TEMP_DIR=/tmp/ppos-preflight

EXPOSE 8001

CMD ["node", "server.js"]
