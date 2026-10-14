---
"@agentproto/apps": patch
---

Cache the panel generation instead of re-running it on every apps command. `generate:ui` (the three Vite panel builds behind one entry) is now a turbo task — `packages/apps/turbo.json`, inputs scoped to the `ui/**` sources, `panel-bridge.ts`, the vite configs and the three build scripts, outputs the three gitignored `panel.generated.ts` modules — and `build` / `check-types` / `test` depend on it, so an unchanged UI is a cache hit instead of three fresh Vite builds. Outside turbo the `prebuild`/`precheck-types`/`pretest`/`pretest:watch` hooks fall back to `scripts/ensure-ui-generated.mjs`, which generates only when a file is missing, so a fresh clone still works with plain `pnpm --filter @agentproto/apps build` / `test`.
