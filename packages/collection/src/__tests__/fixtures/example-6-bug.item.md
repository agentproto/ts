---
schema: collection.item/v1
collection: bugs
id: BUG-1042
title: Login form crashes on Safari 17 with autofill enabled

# Universal-ish fields — collection.ownership says assignee is optional
status: triaged
assignee: ws://operators/eng-frontend-lead
tags: [auth, safari, autofill, regression]
createdAt: 2026-04-26T09:14:00Z
updatedAt: 2026-04-27T11:02:00Z
attachments:
  - sources/2026-04-26-safari-crash-trace.txt

# Collection-specific fields
severity: high
affectedVersion: 4.2.1
repro: |
  1. Open https://app.example.com/login in Safari 17.4.
  2. Have password autofill enabled.
  3. Tap the email field; tap the password field once autofill kicks in.
  4. Observe: page goes white, console shows
     `TypeError: Cannot read properties of null (reading 'addEventListener')`.

metadata:
  example_corp:
    sentry_issue_id: SEN-9482
---

# Login form crashes on Safari 17 with autofill enabled

## Context

Reported via support ticket on 2026-04-26 by three customers within ten minutes
of each other. Sentry triage points at the `useFocusGuard` hook — Safari's
autofill races the React mount and the hook's ref hasn't been set when
`addEventListener` runs.

## Working hypothesis

`useFocusGuard` should defer the listener attach until after mount; current code
runs in `useLayoutEffect` synchronously.

## Resolution path

- [ ] Reproduce locally on Safari 17.4 (Tom — owner).
- [ ] Patch `useFocusGuard` to defer.
- [ ] Add Playwright test against autofill flow.
