---
"@agentproto/runtime": patch
---

Let `tunnel_delete` forget a `cloudflare-provisioned` record that was never provisioned remotely while the provider is unconfigured, and keep refusing to delete one with a stored remote tunnel id.
