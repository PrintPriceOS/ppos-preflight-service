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
COPY ppos-preflight-service ./

# Destroy any leaked host node_modules to guarantee a clean slate
RUN rm -rf node_modules package-lock.json

# Pack local internal libraries into immutable tarballs
RUN cd libs/ppos-preflight-engine && npm pack && mv *.tgz ../../engine.tgz
RUN cd libs/ppos-shared-infra && npm pack && mv *.tgz ../../infra.tgz
RUN cd libs/ppos-shared-contracts && npm pack && mv *.tgz ../../contracts.tgz

# Reroute package.json strictly to the packed tarballs to bypass all symlink bugs
RUN sed -i 's|"file:./libs/ppos-preflight-engine"|"file:./engine.tgz"|g' package.json
RUN sed -i 's|"file:./libs/ppos-shared-infra"|"file:./infra.tgz"|g' package.json

# Standard installation (Node will extract tarballs natively as a real npm install)
RUN npm install --only=production --no-audit

# Environment configuration
ENV PPOS_SERVICE_PORT=8001
ENV GS_COMMAND=gs
ENV PPOS_TEMP_DIR=/tmp/ppos-preflight

EXPOSE 8001

CMD ["node", "server.js"]
