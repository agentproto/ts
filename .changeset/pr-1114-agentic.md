---
"@agentproto/app-kit": minor
"@agentproto/cli": minor
"@agentproto/runtime": minor
"@agentproto/skill-pack-agentproto": patch
---

Give installed apps a data directory distinct from their source directory. The `app_data_*` plane now anchors to `InstalledApp.dataDir` (default `<dir>/data`) rather than the app's `dir`. Custom data directories are set with `app_install {dataDir}` / `agentproto app install --data-dir`, or hinted by APP.md `data: { dir }`. Full backward compatibility: pre-dataDir files under `<appDir>` are still found via fallback; under the default layout the legacy `data/` spelling is collapsed so existing paths continue to work.
