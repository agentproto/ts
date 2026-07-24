# gbrain runtime (tracked)

The self-contained, version-pinned gbrain code-intelligence backend for this
adapter — relocated here from the studio's `deployment/gbrain-pilot/` (Ph3
Jeremy decision #1: the adapter owns its runtime). gbrain itself is an external
OSS binary ([garrytan/gbrain](https://github.com/garrytan/gbrain), v0.42.62.0);
this directory tracks only the launcher: the Postgres+pgvector compose, the
image `Dockerfile`, and the entrypoints.

## Files

| File | Role |
|---|---|
| `docker-compose.pg.yml` | The `gbrain-pg` + `gbrain-pg-db` stack (Postgres backend → concurrent `sync` + `serve`). |
| `Dockerfile` | Builds `gbrain-pilot:latest` from `github:garrytan/gbrain` (Bun image). |
| `entrypoint-pg.sh` | Postgres entrypoint: `gbrain init --url … && gbrain serve --http`. |
| `entrypoint.sh` | PGLite entrypoint (referenced by the `Dockerfile` COPY; kept for the single-writer variant). |
| `.env.pg.example` | Template for the gitignored `.env.pg` (bootstrap token, OpenAI key, bearer). |

## Run

```bash
cp .env.pg.example .env.pg            # fill in the secrets
docker compose -f docker-compose.pg.yml --env-file .env.pg up -d --build
docker exec gbrain-pg gbrain code-def ImporterRunner   # smoke test (expect ready:true)
```

The container name `gbrain-pg` is what `GbrainLocalProvider` shells into
(`docker exec gbrain-pg gbrain …`, override with `GBRAIN_DOCKER_CONTAINER`).
The HTTP port `3132` is what `GbrainHttpProvider` targets (override with
`GBRAIN_HTTP_ENDPOINT`).

## Notes

- **Code-edge readiness is async.** After a fresh `sync`, `code-def` is ready
  immediately but `code-callers`/`code-callees` return `status:"indexing"` /
  `"not_built"` until the edge build finishes — poll a known symbol before
  trusting callgraph results.
- The studio copy at `deployment/gbrain-pilot/` is NOT removed by this PR — its
  deletion is the PR-5 delete-after-verified cleanup.
