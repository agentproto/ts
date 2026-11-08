---
"@agentproto/app-shell": minor
---

New package: a public, framework-free shell for agent apps. It ships the `tokens.css` and `components.css` stylesheets, `KITS`/`applyKit`/`initialKit` (the storage key is explicit, no default), and `renderShell`/`renderTopbar` markup helpers. `brand` and `logo` are required and every user-facing label is a parameter with a neutral default. The two built-in kits are exposed as `paper` and `graphite`. Plain ESM and CSS, no runtime dependency.
