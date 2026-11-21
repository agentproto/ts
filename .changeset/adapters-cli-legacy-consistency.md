---
"@agentproto/cli": patch
---

Make `agentproto adapters list`, `show`, and `outdated` consistent for installed adapters without an `agentproto/adapter/v1` runtime manifest (such as AIP-45 agent-CLI adapters like `@agentproto/adapter-antigravity` and legacy side-effect packages):

- `adapters show <pkg|slug>` accepts both bare slugs (`antigravity`) and full package names (`@agentproto/adapter-antigravity`), falling back from runtime manifests to `resolveAdapter(slug)` (AIP-45 handle summary) and installed `package.json` inspection instead of failing with `not installed (or doesn't declare an agentproto manifest)`.
- `adapters list` surfaces AIP-45 agent-CLI metadata (slug, protocol, package version) and installed-but-unconfigured adapters alongside configured entries instead of labeling agent-CLI packages as `(no manifest — legacy side-effect adapter)`.
- `adapters outdated` reads the resolved adapter's `package.json#version` (`AdapterInfo.packageVersion`) before falling back to `npm ls -g`, eliminating `(not global — version unknown)` for local/workspace/non-global installs, and pins `npm ls -g` to the CLI's global prefix when applicable.
