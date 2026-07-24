#!/bin/sh
# gbrain pilot (Postgres+pgvector backend) — multi-connection, so `sync` (CLI)
# and `serve` (HTTP) can run concurrently, unlike single-writer PGLite.
set -e
mkdir -p "${HOME}/.gbrain"

# Init against the external Postgres if this brain isn't wired yet. Idempotent:
# skip when config already points at a db engine.
if ! grep -q '"engine"' "${HOME}/.gbrain/config.json" 2>/dev/null; then
  gbrain init --url "${GBRAIN_DATABASE_URL}" \
    --embedding-model "${GBRAIN_EMBEDDING_MODEL:-openai:text-embedding-3-large}" \
    || gbrain init --url "${GBRAIN_DATABASE_URL}" --no-embedding
fi

exec gbrain serve --http --bind 0.0.0.0 --enable-dcr-insecure
