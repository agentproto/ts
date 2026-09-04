# agentproto-workstation e2b template image.
#
# Pins come from versions.json (single source of truth) via build args —
# see e2b.template.toml [build.args], kept in sync by scripts/sync-templates.mjs.
# `e2b template build` passes them automatically from the toml; for a plain
# `docker build`, pass them explicitly (commands in README.md).

# NOTE: the FROM line is NOT parameterized via ARG — e2b's template builder
# does not interpolate build args into FROM (verified live: `invalid image
# reference '${BASE_IMAGE}'`). The base image is declared in versions.json
# (baseImage) and e2b.template.toml; if it changes, edit the FROM line here
# to match.

FROM e2bdev/code-interpreter:latest

ARG AGENTPROTO_CLI_VERSION
ARG AGENTPROTO_ADAPTERS
ARG OPENCODE_RUNTIME_VERSION

ENV DEBIAN_FRONTEND=noninteractive

# Node + git are the workstation baseline (the e2b base image ships Node;
# install it explicitly so the template also builds from a bare distro).
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates git jq \
  && rm -rf /var/lib/apt/lists/*

# Node 22 (matches the repo's CI runtime; a dependency of @agentproto/cli
# declares engines >=22.19). Always install — the e2bdev base image ships
# Node 20 (verified live).
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
  && apt-get install -y --no-install-recommends nodejs \
  && rm -rf /var/lib/apt/lists/*

# Baked toolchain: pinned agentproto CLI + adapters + OpenCode runtime.
# One `npm i -g` per layer group so a pin bump invalidates only its layer.
# Adapters ride in the SAME invocation as the CLI — a later CLI install
# replaces the global tree and would otherwise lose them (the on-boot
# `npm i -g` path in @agentproto/sandbox-e2b has the same constraint).
RUN npm i -g @agentproto/cli@${AGENTPROTO_CLI_VERSION} ${AGENTPROTO_ADAPTERS}
RUN npm i -g opencode-ai@${OPENCODE_RUNTIME_VERSION}

# --- Build-time smoke checks: fail the build, not a live agent turn. ---

# 1. The pinned CLI is what's on PATH. Matched as a substring of
#    `agentproto --version` output (that output is not specified as exactly
#    the bare semver — verified live it can differ, e.g. a v-prefix).
RUN agentproto --version | grep -q "${AGENTPROTO_CLI_VERSION}" \
  || (echo "smoke: agentproto --version does not contain ${AGENTPROTO_CLI_VERSION}" && agentproto --version && exit 1)

# 2. Adapter discovery sees every baked adapter.
RUN agentproto adapters list --json | jq -e . >/dev/null \
  || (echo "smoke: agentproto adapters list --json failed" && exit 1)
RUN for pkg in ${AGENTPROTO_ADAPTERS}; do \
      npm ls -g --depth=0 "${pkg%%@*}" >/dev/null \
        || (echo "smoke: baked adapter missing: $pkg" && exit 1); \
    done

# 3. The daemon boots and answers /health on the provider's default port.
RUN agentproto serve --port 18790 --bind 127.0.0.1 --workspace /home/user >/tmp/serve.log 2>&1 & \
    SERVE_PID=$!; \
    for i in $(seq 1 30); do \
      curl -fsS http://127.0.0.1:18790/health >/dev/null 2>&1 && break; \
      sleep 1; \
    done; \
    curl -fsS http://127.0.0.1:18790/health >/dev/null \
      || (echo "smoke: daemon /health never came up" && cat /tmp/serve.log && kill $SERVE_PID && exit 1); \
    kill $SERVE_PID
