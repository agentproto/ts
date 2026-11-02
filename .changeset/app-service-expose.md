---
"@agentproto/app": minor
"@agentproto/runtime": minor
---

AIP-53 `services[].expose`: a service declared in APP.md can ask the host for a public URL through a tunnel.

- `@agentproto/app`: `AppService.expose?: { auth?: "guard" | "service"; hostname?: string }` (new `AppServiceExpose` type), validated by `parseServiceList`, `defineApp` and the loader, carried through `emit`. Closed object, `auth` enum, hostname a lowercase DNS label or FQDN; `expose` without `port` is rejected with `services[i].expose requires a port`.
- `@agentproto/runtime`: one tunnel per exposed service through the daemon's `TunnelRegistry`, keyed `app.<a>.<s>.<h>` (AIP-53 Tunnel key: slugged app id, service name, 8 hex of sha256 of `<appId>:<name>`, always within the provisioner key alphabet; new `TunnelRegistry.ensureKeyed` / `findByKey`, tunnels found again by their stamped owner), so a reinstall or a daemon boot gets the same tunnel back. A kept service whose spawn origin is no longer the current one is respawned with the new `AGENTPROTO_PUBLIC_URL`. The tunnel is ensured before the process spawns and the bare origin is passed as `AGENTPROTO_PUBLIC_URL`; `auth: service` is an unguarded tunnel, `auth: guard` keeps the access guard and never puts the entry link in the env. A failed tunnel never fails the install nor blocks the process. The install result and `app_status` report each exposure (publicUrl, auth, stable, state, tunnelId). Uninstall, removing the service, or dropping `expose` deletes the tunnel. The provider is host config, `defaults.apps.exposeProvider`; unset, it is `cloudflare-provisioned` when registered, else `cloudflare-managed`, else `cloudflare-quick` reported as not stable.
