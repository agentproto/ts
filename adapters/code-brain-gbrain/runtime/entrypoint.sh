#!/bin/sh
# gbrain pilot entrypoint: lock-hygiene → init-if-absent → serve.
set -e
BRAIN="${HOME}/.gbrain"
PG="${BRAIN}/brain.pglite"

# PGLite is single-writer. A container killed with SIGKILL (docker rm -f) leaves
# a stale lock dir that makes the next start time out. Clear it defensively.
rm -rf "${PG}/.gbrain-lock" "${PG}/postmaster.pid" "${BRAIN}/.locks" 2>/dev/null || true

# First boot on a fresh volume: create the brain. Prefer real embeddings when an
# OpenAI key is present (turns on hybrid vector+BM25 search); else keyword-only.
if [ ! -f "${PG}/PG_VERSION" ]; then
  if [ -n "${OPENAI_API_KEY}" ]; then
    gbrain init --pglite --embedding-model openai:text-embedding-3-large
  else
    gbrain init --pglite --no-embedding
  fi
fi

# --enable-dcr-insecure enables the client_credentials grant our adapter uses
# (machine-to-machine, no human consent). Fine for a LOCAL pilot only.
exec gbrain serve --http --bind 0.0.0.0 --enable-dcr-insecure
