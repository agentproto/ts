# demos/rift — local run instructions

## Prerequisites

- Node ≥ 20.9.0
- pnpm (workspace package-manager, version set in root `package.json`)

## Quick start

From the **repo root**, install workspace dependencies once (first time or after lockfile change):

```sh
pnpm install
```

Then from `demos/rift/`:

```sh
# Run the demo (deterministic local runner, no network or model calls)
pnpm dev

# Run baseline tests
pnpm test

# Type-check
pnpm check-types
```

### What these commands do

| Command | Implementation |
|---------|---------------|
| `pnpm dev` | `node --import tsx src/run.ts` — loads mock data, creates app shell, prints card to stdout |
| `pnpm test` | `vitest run` — runs demo-specific tests in `src/__tests__/` |
| `pnpm check-types` | `tsc --noEmit` — type-checks the demo package only |

### Notes

- The root-level `pnpm test` and `pnpm check-types` scripts filter to `packages/**` and `adapters/**` only — they do **not** include `demos/**`. Always run the demo-specific commands above.
- Mock data is deterministic. Claims/sources in `src/mock-data.ts` are cited fixtures grounded in real, independently-verified public records (GitHub repo metadata, a vendor pricing page) — no fabricated URLs, dates, excerpts, metrics, or citations. See `EVIDENCE.md` for the full research log, including categories that were checked and rejected as unusable.
