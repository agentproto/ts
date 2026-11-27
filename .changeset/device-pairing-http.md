---
"@agentproto/runtime": minor
"@agentproto/app": minor
"@agentproto/cli": minor
---

A phone app can now be connected to your agent apps with a one-time link, without holding the key to the whole daemon. The new `device_offer` tool sends a link (Telegram message with a button, or returned on request) that works once for 10 minutes; the device that opens it shows a two-digit number, and you confirm on the machine's chat channel by comparing it. The device then receives its own revocable token, limited to the apps you granted (`"*"` or a list) and optionally the session read routes. Out-of-grant use answers `grant_out_of_scope`; a revoked device answers `access_revoked`, and a device idle for 90 days loses its access.

Such a device shows up in `agentproto devices list` (kind `app`, with its apps) and is renamed and revoked with `device_rename` / `device_revoke` and the `devices` commands; `device_pair_pending` lists requests waiting for confirmation. No tool can confirm a request, and without a confirmation channel nothing is granted. The daemon serves the link's landing page at `/pair` and the Android App Links proof from `~/.agentproto/assetlinks.json`.

An app can opt out of being opened from another device with `access: { remote: false }` in `APP.md`. Follows AIP-59 section 9 and AIP-53 `access`.
