# Wake an agent when CI or a review lands on its PR

Status: Stable for `local-gh` (136 sentinels in real use)

An agent that opens a PR and then just sits there idle wastes a turn: CI
takes minutes, a human review can take hours. A sentinel is a persisted
watch that waits for a GitHub event - a check finishing, a review landing,
the PR closing - and delivers it straight into the owning session's inbox,
re-prompting the session so it can act on the result without a human
polling `gh pr checks` on its behalf.

This guide covers the `local-gh` provider end to end - zero infrastructure,
the only path with real production usage today - then two experimental
targets with no real usage yet, then what sentinels don't do.

## End to end

1. **An agent opens a PR.** Whether it ran `gh pr create` itself (via
   `command_execute`) or a reconciler later discovers the PR it opened, the
   daemon records it against the session.

2. **The daemon auto-watches it - no action needed.** On a newly recorded
   PR, the daemon creates a sentinel for the owning session automatically:
   `match: github:owner/repo#N` with the default PR type set, `until:
   subject_terminal` (expires when the PR closes or merges), delivered back
   at `next-turn` urgency. This is `agentproto sentinel watch pr` running
   itself, not something you call.

   This auto-watch is gated by (in order):
   - **Per-spawn opt-out.** `agent_start`'s `sentinel: false` disables it for
     that one session, regardless of the daemon config.
   - **`config.sentinel.autoWatchPrs`.** Unset, it defaults to `true` only
     when `local-gh` is usable (the host's `gh` CLI is authenticated) -
     otherwise `false`, logged once. Set it explicitly to override the
     probe:
     ```bash
     agentproto config set sentinel.autoWatchPrs true
     ```
     Takes effect on the next PR a session opens - no daemon restart.

   You can also watch a PR (or any subject) by hand - see
   [`sentinel.md`](../verbs/sentinel.md):
   ```bash
   agentproto sentinel watch pr https://github.com/owner/repo/pull/42 --session sess_abc123
   ```

3. **`local-gh` polls.** Every 15-60 seconds (faster right after recent
   activity, slower once a sentinel's been quiet for 10+ minutes), the
   daemon diffs the PR's state over the host's already-authenticated `gh`
   CLI - no credentials to configure, no public URL, no webhook to manage.
   It produces events for: a check suite completing, a new commit pushed, a
   review submitted, the PR closing or merging. (It does not poll comments -
   see [Providers](../verbs/sentinel.md#providers).)

4. **CI finishes, or a review lands.** The next poll sees the state change
   and emits a matching event.

5. **The owning session is re-prompted.** The event lands in the session's
   inbox as a `notice` message at the sentinel's configured urgency
   (`next-turn` by default) - if the session is idle, this starts a fresh
   turn; if it's mid-turn, the notice queues behind it. The agent sees
   something like `[github] Check suite failure for owner/repo#42` with the
   structured event data attached, and can act on it (fix the failing check,
   respond to review comments, merge) in the same session that opened the PR
   - no new session, no lost context.

   If the session already exited (crashed, or was resumable but torn down),
   the daemon resumes it via the same path `inbound-router.ts` uses for any
   other inbound message before delivering. A session closed on purpose
   (`done`/`abandoned`) is never resumed - the notice instead goes to its
   live parent at `fyi` urgency, or is parked if there's no live parent.

## Listing, stopping, expiry

```bash
agentproto sentinel list                 # every sentinel the daemon knows about
agentproto sentinel status sen_01ABC...  # one sentinel's full detail
agentproto sentinel rm sen_01ABC...      # stop and remove it
```

A sentinel created with `until: closed` (the default for `watch pr`, and for
the PR auto-watch) expires on its own once the PR reaches a terminal state
- merged or closed - no `rm` needed. A sentinel watching a raw subject
defaults to `until: never` (the caller presumably wants `rm` to be the only
way out).

Expiry is checked on every poll, on every delivery, and swept periodically
on daemon boot and while running - an expired sentinel's provider-side watch
is torn down and it's flipped to `status: expired` (still visible in
`sentinel list`, no longer polled).

Full reference, including every flag: [`sentinel.md`](../verbs/sentinel.md).

## Experimental: webhook and agentpush targets

Status: Experimental - no real usage yet (`local-gh` is the only provider
with production sentinels today).

- **`webhook`** - near-real-time push via a GitHub repo webhook, instead of
  polling. Needs a **public URL** for the daemon (a named tunnel via
  [`tunnel.md`](../verbs/tunnel.md), or the `AGENTPROTO_PUBLIC_URL`
  environment variable) and a `gh` token scoped `admin:repo_hook` (or
  `write:repo_hook` / `repo`) to create the hook. Without both, `readiness()`
  reports why and `sentinel watch --provider webhook` fails with the
  specific fix needed rather than silently falling back.

- **`agentpush`** - a hosted durable subscription: agentpush queues matching
  events server-side, so they survive the daemon being offline, and can push
  to the daemon or be polled. Needs an agentpush workspace API key, set up
  via the `setup_sentinel_provider` MCP tool (not reachable through this
  CLI's `--provider` flag directly - once configured, auto-selection picks
  it over `webhook`/`local-gh` automatically). It's a separate, paid hosted
  service, not something the daemon runs itself.

With neither configured, `--provider` omitted always resolves to `local-gh`.

- **`webhook` target** - a sentinel can also deliver matching events as signed
  HTTP POSTs to a callback URL instead of into a session's inbox. This is a
  different thing from the `webhook` provider above. The signature scheme,
  secret rotation, callback verification, SSRF rules, retry schedule and
  persisted outbox are in the
  [Sentinel webhook target reference](../reference/sentinel-webhook.md).

## What it doesn't do

- **No backfill.** A sentinel only sees events from the moment it's created
  onward - it does not retroactively discover a review or check that
  already finished before the watch started.
- **`local-gh` doesn't watch comments.** `github.issue_comment.created` is
  in the default PR type set but `local-gh` doesn't produce it - add
  `webhook` or `agentpush` for comment events.
- **It delivers, it doesn't decide.** A sentinel's job ends at landing the
  event in the session's inbox at the requested urgency. Whether that
  starts a new turn immediately, queues, or just sits in the inbox as `fyi`
  is ordinary inbox-delivery behaviour, not something sentinels add on top.
- **A deliberately closed session is never resumed** to receive an event -
  the notice is rerouted to a live parent (if any) instead, never silently
  dropped, but also never forces a closed session back open.
- **No cross-repo or non-GitHub coverage today.** Every built-in provider
  watches GitHub subjects; there's no sentinel for, say, a CI system that
  isn't GitHub Actions reporting through GitHub's check-run API.
