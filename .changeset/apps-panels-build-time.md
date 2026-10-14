---
"@agentproto/apps": patch
---

Build the three panel HTML bundles (work-board, review-panel, store) at build time instead of committing `src/**/panel.generated.ts`. A new `generate:ui` script (the three existing `build:ui*` scripts behind one entry) runs from `prebuild`/`precheck-types`/`pretest`/`predev`, the generated files are gitignored and dropped from git, and CI's three UI drift-check steps go away — a PR that touches `panel-bridge.ts` or a panel UI no longer has to regenerate and commit a large generated file, and it can no longer conflict or land stale on main.
