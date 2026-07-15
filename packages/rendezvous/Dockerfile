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

# Manifest + prebuilt bundle only.
#
# devDependencies are stripped from the manifest before install rather than
# skipped with --omit=dev: this package dev-depends on `@agentproto/tooling`
# at `workspace:*`, and npm rejects the `workspace:` protocol while *parsing*
# the manifest (EUNSUPPORTEDPROTOCOL) — before --omit=dev gets to exclude it.
# pnpm resolves that protocol, npm never will, so the field cannot survive here.
# What's left is the single runtime dep, `ws`.
COPY --chown=rendezvous:rendezvous package.json ./
COPY --chown=rendezvous:rendezvous dist ./dist
RUN node -e "const fs=require('fs'),p=JSON.parse(fs.readFileSync('package.json','utf8'));delete p.devDependencies;delete p.scripts;fs.writeFileSync('package.json',JSON.stringify(p,null,2))" && \
    npm install --omit=dev --no-audit --no-fund --no-package-lock && \
    npm cache clean --force

# Numeric UID, not the `rendezvous` name: Kubernetes cannot verify a username
# maps to a non-root user, so `runAsNonRoot: true` (the standard hardened
# posture, mandatory under PodSecurity `restricted`) refuses to start the
# container with CreateContainerConfigError. The numeric form is equivalent to
# `USER rendezvous` for docker run, and portable to k8s.
USER 1001

# Default bind port (RENDEZVOUS_PORT overrides at runtime).
EXPOSE 8788

# Liveness against the payload-free health route.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:8788/healthz || exit 1

ENTRYPOINT ["node", "./dist/cli.mjs"]
CMD ["serve"]
