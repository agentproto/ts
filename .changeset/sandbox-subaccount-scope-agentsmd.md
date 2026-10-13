---
"@agentproto/runtime": patch
---

Sandbox spawns now carry a sub-account profile's scoping into the box: the provider's extra env (e.g. an opencode console org's inline `provider` config), the env var its bearer rides in, and the login-less data-home opt-out are forwarded beside the credential in `auth` (`credentialEnv` / `extraEnv` / `isolateDataHome`) and applied by the box's own driver, which layers the extra env over the adapter's lean inline config instead of replacing it — fixes `Workspace selection is required` for `access.profileRef` on a sub-account profile with `sandbox`. Sandbox spawns also never hand the box a host path to `AGENTS.md`: pointer mode is dropped and inline mode omits the host path from the fence header.
