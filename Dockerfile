# @ppos/preflight-service - Hardened v2.6

FROM node:20-bookworm-slim AS builder

WORKDIR /build
COPY ppos-preflight-engine ./ppos-preflight-engine
COPY ppos-shared-infra ./ppos-shared-infra
COPY ppos-shared-contracts ./ppos-shared-contracts

RUN cd ppos-preflight-engine && TARBALL="$(npm pack | tail -n 1)" && mv "$TARBALL" ../engine.tgz
RUN cd ppos-shared-infra && TARBALL="$(npm pack | tail -n 1)" && mv "$TARBALL" ../infra.tgz
RUN cd ppos-shared-contracts && TARBALL="$(npm pack | tail -n 1)" && mv "$TARBALL" ../contracts.tgz

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

# ------------------------------------------------------------------
# Industrial PDF runtime dependencies
# Required for REAL_EXTRACTION and hard environment gate validation
# ------------------------------------------------------------------
RUN apt-get update && apt-get install -y --no-install-recommends \
  ghostscript \
  qpdf \
  poppler-utils \
  mupdf-tools \
  libimage-exiftool-perl \
  which \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

# Deterministic runtime PATH for child_process spawn probes
ENV PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

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

# ------------------------------------------------------------------
# Build-time verification of industrial probes
# ------------------------------------------------------------------
RUN set -eux; \
  command -v pdfinfo; \
  command -v pdfimages; \
  command -v mutool; \
  command -v gs; \
  command -v qpdf; \
  command -v exiftool; \
  pdfinfo -v || true; \
  pdfimages -v || true; \
  mutool -v || true; \
  gs --version; \
  qpdf --version; \
  exiftool -ver

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8001/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

EXPOSE 8001

CMD ["node", "server.js"]