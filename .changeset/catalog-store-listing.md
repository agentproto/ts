---
"@agentproto/runtime": minor
"@agentproto/cli": minor
"@agentproto/app-kit": patch
---

Store listing fields on app-catalog/v1 entries (all optional): `tagline`, `longDescription` (markdown), `screenshots` ({url, alt, width?, height?}), `categories`, `homepage`, `repository`, alongside the existing `icon` and `publisher`. Declared in an APP.md `store:` block and written by `agentproto app pack --release --entry`, which checks the media and copies them to `media/<appId>/<version>/` next to the entry (`--media-base-url` relocates them). `agentproto catalog verify` checks the listing (limits, https, alt text, image format and size); `--local-media <prefix>=<dir>` reads media from a checkout. `store/` is left out of release bundles. A relative top-level APP.md `icon` is no longer copied into a public entry.
