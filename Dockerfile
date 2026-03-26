# @ppos/preflight-service - Hardened v2.6

FROM node:20-bookworm-slim AS builder

WORKDIR /build
COPY ppos-preflight-engine ./ppos-preflight-engine
COPY ppos-shared-infra ./ppos-shared-infra
COPY ppos-shared-contracts ./ppos-shared-contracts

RUN cd ppos-preflight-engine && npm pack && mv *.tgz ../engine.tgz
RUN cd ppos-shared-infra && npm pack && mv *.tgz ../infra.tgz
RUN cd ppos-shared-contracts && npm pack && mv *.tgz ../contracts.tgz

FROM node:20-bookworm-slim AS installer

WORKDIR /app
COPY ppos-preflight-service/package.json ./
COPY --from=builder /build/*.tgz ./

RUN sed -i -E 's|"file:.*ppos-preflight-engine"|"file:./engine.tgz"|g' package.json && \
    sed -i -E 's|"file:.*ppos-shared-infra"|"file:./infra.tgz"|g' package.json && \
    sed -i -E 's|"file:.*ppos-shared-contracts"|"file:./contracts.tgz"|g' package.json

RUN rm -f package-lock.json
RUN npm install --omit=dev --no-audit

FROM node:20-bookworm-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends ghostscript && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 1. Copy service source
COPY ppos-preflight-service/ ./

# 2. Remove any host-side dependency artifacts that leaked from the umbrella context
RUN rm -rf node_modules package-lock.json

# 3. Restore clean installed dependencies + patched manifest from installer
COPY --from=installer /app/node_modules ./node_modules
COPY --from=installer /app/package.json ./package.json

ENV NODE_ENV=production
ENV PPOS_SERVICE_PORT=8001
ENV GS_COMMAND=gs
ENV PPOS_TEMP_DIR=/tmp/ppos-preflight

EXPOSE 8001
CMD ["node", "server.js"]
