---
"@agentproto/sandbox-e2b": minor
"@agentproto/runtime": patch
---

Introduce template version management system for agentproto-workstation e2b template. Establishes `templates/workstation/versions.json` as the canonical pin declaration (CLI, adapters, runtime, base image) and introduces `scripts/sync-templates.mjs` to regenerate all derived artifacts. Enhances `@agentproto/sandbox-e2b` provider with `resolveUpdateCli()` function to intelligently skip the on-boot CLI install when a template's recorded baked image provably carries the requested CLI version—defaulting conservatively to install when the bake is unproven, maintaining backward compatibility.
