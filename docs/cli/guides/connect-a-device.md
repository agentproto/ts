# Connect a phone to your agent apps

A phone app (the agentproto hub shell) can open the apps your daemon serves
without holding the key to the whole daemon. You send yourself a one-time link,
tap it on the phone, and confirm on the machine's chat channel by comparing a
number. The phone then holds its own revocable token, limited to the apps you
granted.

## 1. Send the link

Ask for an offer with the `device_offer` MCP tool (from your assistant, or any
MCP client):

```jsonc
device_offer { "apps": "*", "baseUrl": "https://<your-tunnel>" }
// or only some apps, plus read access to sessions for a chat viewer:
device_offer { "apps": ["@acme/notes"], "sessionsRead": true, "baseUrl": "https://<your-tunnel>" }
```

- `apps` is `"*"` (every app with a UI) or the exact ids. The control of the
  whole daemon is never granted this way.
- With Telegram set up (`approvals.telegramApprovalCards`), the link arrives as a
  message with a **Connect this device** button, and the tool answers without the
  link, so the code never enters a model's context. `deliver: "return"` returns
  the link instead; treat it like a password.
- The link (`https://<host>/pair#o=<code>`) works once and expires in 10 minutes.
  The code sits in the URL fragment, so no server or log sees it. A QR code is the
  same link.

`baseUrl` is the public https address of the daemon (its tunnel); it can come from
`AGENTPROTO_PUBLIC_HTTP_ORIGIN`. To let Android open the app straight from the
link, put the Digital Asset Links proof for the app at
`~/.agentproto/assetlinks.json`; the daemon serves it at
`/.well-known/assetlinks.json`. Without it, the page at `/pair` offers a button.

## 2. Confirm

The phone shows a two-digit number and waits. The daemon sends a confirmation
card (Telegram, or the approval page) naming the device and repeating that number.
Confirm only if the numbers are the same: a forwarded link used by someone else
shows a different number. Nothing is granted before you confirm, and no tool can
confirm for you.

## 3. Manage devices

A paired phone is a device like the others:

```sh
agentproto devices list      # kind "app", with the apps it may open
agentproto devices rename <id|name> <new-name>
agentproto devices revoke <id|name>
```

The MCP tools `device_list`, `device_rename` and `device_revoke` do the same, and
`device_pair_pending` lists requests waiting for a confirmation. Revocation takes
effect on the phone's next call, which then reads "access withdrawn". A device
that is not used for 90 days loses its access. Uninstalling an app removes it
from every device's grant.

## What a device can do

- open the apps of its grant (`GET /apps/<id>/ui`), and call each app's own
  `ui.tools` through `POST /apps/<id>/tool-call`;
- with `sessionsRead`, read the session routes (`GET /sessions/...`);
- `GET /device/me` returns its identity and the app list the shell shows.

Anything else answers 401, and an app outside the grant answers
`grant_out_of_scope`. An app can opt out of being opened from another device with
`access: { remote: false }` in its `APP.md`.

This is the HTTP binding of AIP-59 section 9.
