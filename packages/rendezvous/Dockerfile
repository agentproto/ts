# @agentproto/rendezvous — the untrusted pairing broker, as a container.
#
# The package is standalone (its only runtime dependency is `ws`), so we build
# the bundle in the monorepo and copy the prebuilt `dist/` in. A package-local
# `pnpm run build` inside the image would fail, because this package's tsup /
# tsconfig extend workspace tooling that isn't present in a single-package
# build context (and the pnpm lockfile lives at the monorepo root, not here).
#
# Build the bundle first, THEN build the image from this package directory:
#   pnpm --filter @agentproto/rendezvous build
#   docker build -t agentproto-rendezvous packages/rendezvous
#
# (dist/ must exist — see .dockerignore, which intentionally keeps it.)

FROM node:20-alpine AS runtime

# Run as a non-root user.
RUN addgroup -g 1001 -S rendezvous && \
    adduser -u 1001 -S rendezvous -G rendezvous

WORKDIR /app

# Manifest + prebuilt bundle only. The runtime dep (`ws`) is installed from the
# manifest; devDependencies (tsup, etc.) are skipped via --omit=dev.
COPY --chown=rendezvous:rendezvous package.json ./
COPY --chown=rendezvous:rendezvous dist ./dist
RUN npm install --omit=dev --no-audit --no-fund --no-package-lock && \
    npm cache clean --force

USER rendezvous

# Default bind port (RENDEZVOUS_PORT overrides at runtime).
EXPOSE 8788

# Liveness against the payload-free health route.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:8788/healthz || exit 1

ENTRYPOINT ["node", "./dist/cli.mjs"]
CMD ["serve"]
