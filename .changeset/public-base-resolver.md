---
"@agentproto/runtime": patch
"@agentproto/cli": patch
"@agentproto/pairing-host": patch
---

One public-base resolver (`resolvePublicBase`) so app pages and their links no longer point at 127.0.0.1 behind a tunnel or the rendezvous. Order: `AGENTPROTO_PUBLIC_HTTP_ORIGIN` (a path prefix is now accepted), a daemon-signed `x-agentproto-public-base` header, `X-Forwarded-Host`/`X-Forwarded-Proto`, a non-loopback `Host`, loopback. An `X-Forwarded-Host` with no `X-Forwarded-Proto` now defaults to https for a DNS name (http for localhost, `*.local`, IP literals and single-label hosts), instead of http. The signed header is HMAC-keyed per process, so a client-sent copy is ignored. Pairing channels inject it with the pair page's `<fp>.<domain>/d/<fp>` base (`PairingChannelContext.daemonFingerprint`, `buildDaemonTunnelServerOptions({ publicBase })`), and link-guard now forwards `x-forwarded-proto` plus a signed base for a public Host while stripping client copies. `/mcp` builds panel html per request against that base (`mcpServerFactory` gains a ninth `requestBaseUrl` argument, `injectMcpAppBridge(html, baseUrl?)`, `makeInstalledAppUiApps(..., baseUrl?)`), and the terminal panel derives its WebSocket base from it.
