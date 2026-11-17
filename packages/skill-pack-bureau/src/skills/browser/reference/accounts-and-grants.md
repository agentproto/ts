# Accounts and grants

An **Account** is a site login inside a browser profile. It is the unit agents
are given access to, and the unit you list before any task. Never inspect,
extract or replay cookies yourself: the browser owns them, and a cookie read is
refused.

## What an account carries

| Field | Meaning |
| --- | --- |
| `id` | stable account id |
| `site` | the site it belongs to (for example `example.com`) |
| `account` | the visible account name, sometimes an email |
| `profileRef` | the profile it lives in, as `<instance>/<profile>` |
| `session` | `valid`, `expired` or `unknown`, with `verifiedAt` when known |
| `source` | `native` (signed in inside this profile) or `synced` (copied from another profile, with `syncedFrom` and `syncedAt`) |
| `grantIds` | the grants that authorize agents to use it |

An account record authorizes nothing by itself, and it never contains a cookie,
token or storage value.

## Session state

`session` is an observed state, set by the browser's read-only probe. It answers
"does this site still accept me?".

- `valid`: the site accepts the session.
- `expired`: it does not. An owned (camofox) account with a stored credential
  can be signed in again with `session_reauth`; otherwise a human signs in
  again, or a sync from its source account fixes it when it is `synced`
  (`session_sync_from_chrome`).
- `unknown`: not probed recently. Treat it as unverified and expect a wall.

## Grants

A **grant** is an authorization decided by a human, revocable, and recorded in
the consent ledger. `grantIds` on the account lists the ones that currently
apply.

- Missing grant: the tool answers `browser:consent_required`. Ask the user. An
  agent cannot create, widen or renew a grant.
- The manifest lists the `attach` grant; revoking it also deletes any recording
  tied to that grant.
- Recording an attached instance is off by default and only the operator turns
  it on.

## Consent to attach

An attached browser may need the user to allow the connection. While waiting,
the instance sits in state `starting` and calls answer
`browser:awaiting_consent`, a retryable error. This is a human click in their
own browser: report it and stop. Do not retry in a loop.

## Picking an account

1. `browser_list_instances` for the browsers and their `purpose`.
2. `browser_list_accounts` for the accounts and their `session`.
3. Prefer a `valid` account whose profile purpose matches the task.
4. If none is `valid`, say which account is `expired` and what the user must do;
   do not guess or switch identity on your own.
