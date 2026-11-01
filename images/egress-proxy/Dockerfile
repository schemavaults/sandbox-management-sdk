# Egress proxy for Docker sandboxes with a `spec.network` allowlist. The Docker
# provider runs one next to each such sandbox; see README.md, "Network access".
#
# Build from the repository root:
#   docker build -f images/egress-proxy/Dockerfile -t sandbox-egress-proxy .

# The bundle is plain JavaScript, so it is built once on the build platform
# and copied into every target platform's image.
FROM --platform=$BUILDPLATFORM oven/bun:1.4.4-alpine AS build
WORKDIR /build
COPY src ./src
RUN bun build ./src/docker/egress-proxy/main.ts --target=node --format=esm --outfile=/out/egress-proxy.mjs

FROM node:24.22.2-alpine3.24
LABEL org.opencontainers.image.source="https://github.com/schemavaults/sandbox-management-sdk" \
      org.opencontainers.image.description="Egress proxy that enforces network allowlists for @schemavaults/sandbox-management-sdk Docker sandboxes" \
      org.opencontainers.image.licenses="MIT"
COPY --from=build /out/egress-proxy.mjs /app/egress-proxy.mjs
USER node
EXPOSE 3128
# The provider waits for "healthy" before starting the sandbox; --start-interval
# makes that take milliseconds instead of a full interval.
HEALTHCHECK --interval=30s --timeout=3s --start-period=30s --start-interval=100ms --retries=3 \
  CMD ["node", "/app/egress-proxy.mjs", "--health"]
ENTRYPOINT ["node", "/app/egress-proxy.mjs"]
