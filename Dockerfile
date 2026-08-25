# Multi-stage build for the Alternative Payments MCP server.
FROM node:26-alpine AS builder

ARG VERSION="unknown"
ARG COMMIT_SHA="unknown"
ARG BUILD_DATE="unknown"
ARG NODE_AUTH_TOKEN

WORKDIR /app

# Copy package files and .npmrc for GitHub Packages auth (the @wyre-ai
# SDK is public, but npm.pkg.github.com still requires a token to download).
COPY package*.json .npmrc ./

# --ignore-scripts prevents 'prepare' from building before source is copied.
RUN npm ci --ignore-scripts

COPY . .

RUN npm run build

# Prune dev deps while .npmrc auth is still available, then remove the token.
RUN npm prune --omit=dev
RUN rm -f .npmrc

# Production stage
FROM node:26-alpine AS production

# Pull latest Alpine package fixes (e.g. OpenSSL) even when the base layer is cached
RUN apk -U upgrade --no-cache

RUN addgroup -g 1001 -S mcp && adduser -S mcp -u 1001 -G mcp

WORKDIR /app

COPY --from=builder /app/package.json ./
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules

# Remove the bundled npm CLI from the production image; the runtime only needs
# node, and npm's bundled dependencies trigger Trivy base-image CVE alerts.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

USER mcp

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

ENV NODE_ENV=production
ENV LOG_LEVEL=info
ENV MCP_TRANSPORT=http
ENV MCP_HTTP_PORT=8080
ENV MCP_HTTP_HOST=0.0.0.0
ENV AUTH_MODE=gateway

CMD ["node", "dist/http.js"]

ARG VERSION="unknown"
ARG COMMIT_SHA="unknown"
ARG BUILD_DATE="unknown"

LABEL io.modelcontextprotocol.server.name="io.github.WYRE-AI/alternative-payments-mcp"
LABEL maintainer="engineering@wyre.ai"
LABEL org.opencontainers.image.title="alternative-payments-mcp"
LABEL org.opencontainers.image.description="Model Context Protocol server for the Alternative Payments API"
LABEL org.opencontainers.image.version="${VERSION}"
LABEL org.opencontainers.image.created="${BUILD_DATE}"
LABEL org.opencontainers.image.revision="${COMMIT_SHA}"
LABEL org.opencontainers.image.source="https://github.com/WYRE-AI/alternative-payments-mcp"
LABEL org.opencontainers.image.documentation="https://github.com/WYRE-AI/alternative-payments-mcp/blob/main/README.md"
LABEL org.opencontainers.image.vendor="Wyre Technology"
LABEL org.opencontainers.image.licenses="Apache-2.0"
