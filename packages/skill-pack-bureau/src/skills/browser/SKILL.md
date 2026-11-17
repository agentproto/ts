---
name: browser
description: >-
  Drive a real, already-authenticated browser through Bureau's MCP tools: list
  the browsers and site accounts, open your own tab, then navigate, click,
  fill, evaluate, capture and export. The foundation skill for any "do X in a
  browser as me" task. Site recipes ship separately, as recipes.
metadata:
  tags:
    browser, bureau, mcp, automation, recon, screenshots, accounts
---

# Browser: drive pages through Bureau

**One transport: Bureau's MCP tools.** You never open a raw CDP websocket and
you never write a Playwright or CDP script. Bureau owns the browser, the
profiles and the account sessions; you call its tools.

## Which case am I in?

Look at your tool list and stop at the first match:

| You see | Case | How you call Bureau |
| --- | --- | --- |
| A server named `bureau` (`browser_navigate`, `scrape`...) | **A, native** | Call the tools directly. |
| An agentproto connector with `mcp_imported_call` | **B, through agentproto** | `mcp_imported_call({ alias: "bureau", toolName: "browser_navigate", args: {...} })`; schemas with `mcp_imported_tool_list({ alias: "bureau", full: true })`. Same tools, same names as case A. |
| Only `bureau_*` read tools from agentproto (`bureau_screenshot`, `bureau_list_owned_tabs`...) | **C, read only** | Read and watch; to act, ask for case A or B. |
| None of these | **D, no Bureau** | Say so, and ask the user to add a `bureau` MCP server (a stdio client can use `agentproto mcp-bridge --import bureau`). |

Traps: the daemon's own `browser_*` tools (`browser_navigate`,
`browser_press_key`...) are deprecated relays to Bureau with fewer arguments;
prefer Bureau's own tool from case A or B. The `bureau_*` tools of agentproto
are a renamed subset of Bureau's (`bureau_screenshot` is `browser_screenshot`).
Bureau refuses unknown arguments with `browser:unknown_argument` and lists the
accepted ones, so a typo in an argument name is an error, not a silent no-op.

## Start every task the same way

1. `browser_list_instances`: which browsers exist, their `type`
   (`attached` or `dedicated`), their state, which one is the `default`, and
   their purpose.
2. Prefer the default `dedicated` instance for a task: Bureau starts and owns
   it, so it needs no permission and no prior Chrome. Use an `attached`
   instance only when the user names it or the task needs their already
   signed-in Chrome. `instance` (a name from that list) routes the control tools
   (`browser_navigate`, `browser_click`, `browser_fill`, `browser_evaluate`,
   `browser_screenshot`, `browser_get_dom`, `browser_close_tab`,
   `browser_press_key`, `browser_export`, `browser_upload_file`, `browser_record_*`, `browser_live_view`), `browser_list_accounts` and
   `browser_list_owned_tabs`. `browser_act`, `browser_download`, `scrape`,
   the recipe tools and the workflow entry points accept it only for the
   default instance and otherwise fail with `browser:instance_not_supported`,
   because they act in a saved camofox session or read recipe metadata rather
   than a Chrome instance's tab. An unknown name fails and lists the valid
   names, and a tab opened on one instance is refused on another. The agent
   activity border shows on every Chrome instance, on the tabs the agent
   opened.
3. `browser_list_accounts`: which site accounts exist, in which profile, and
   whether their `session` is valid or expired.
4. Pick the account, then open your own tab. `browser_list_owned_tabs` shows
   the tabs you own; without `instance` it lists every instance's owned tabs
   and each row names its own `instance`, so two instances never mix.

Drive tools: `browser_navigate`, `browser_click`, `browser_fill`,
`browser_evaluate`, `browser_screenshot`, `browser_get_dom`, `browser_download`,
`browser_export` (render one of your tabs to a PDF, PNG, HTML or text file),
`browser_upload_file` (attach a file on the Bureau host to an `<input type=file>`,
see `reference/writes.md`), `browser_act` (gated writes), plus `browser_list_requests` and
`browser_get_request_body` for network recon. `browser_press_key` sends
`Escape` to dismiss a menu, `Enter` to submit or `Tab` to move focus.
`browser_new_tab` opens one more tab for your session (optional `url` opens it on
a page; up to 6, chrome and chromium only) and returns its `tabId`: pass it to the page tools to work on
several pages in parallel. `browser_close_tab` closes one of your tabs.
On the dedicated Chrome your session has its own window, named
`[<your label>]` in the title, and all your tabs live in it. `browser_close_window`
closes every tab you own on the instance (and so the window); the end of your
session does the same.
`browser_record_start`,
`browser_record_frame` and `browser_record_stop` record a video of one of your
tabs, and `browser_live_view` shows one live in the chat (see `reference/capture.md`).

Every page tool (`browser_navigate`, `browser_evaluate`, `browser_click`,
`browser_fill`, `browser_screenshot`, `browser_get_dom`) takes an optional
`tabId`: name one of your own tabs and the call runs on THAT tab, not on your
current one. Naming another agent's tab, or a tab you did not open, answers
`browser:not_owner` and drives nothing; an id that no longer exists answers
`browser:target_gone`. Tools that cannot target a named tab on the active
backend (for example a saved camofox session) refuse `tabId` with
`browser:tab_not_supported` instead of silently using another tab.

`browser_click` checks the click point before acting: if another element covers
the target it answers `browser:target_obscured` (with the covering element) and
clicks nothing. Close the overlay first, often with `browser_press_key
{"key": "Escape"}`.

## The four objects

| Object | What it is | Granularity |
| --- | --- | --- |
| **Browser** | the program that runs; its engine is an attribute | the whole browser |
| **Profile** | a jar of cookies inside that browser | one avatar or profile |
| **Account** | a site login inside a profile, with a session state | "my account on a site, in profile X" |
| **Tab** | a page opened in a profile and owned by an agent session | one tab |

An Account has three separate attributes:

| Attribute | Question | Who changes it |
| --- | --- | --- |
| `session` | does the site still accept me? (`valid`, `expired`, `unknown`) | Bureau's probe, read only |
| `grantIds` | may agents use this account? | a human only, never an agent |
| `source` | where the profile's cookies came from: `native` or `synced` | Bureau, within a grant |

## Rules

- **Ownership.** You only see and drive tabs you opened. Any other tab answers
  `browser:not_owner`, on every provider: `chrome-attach` gives you a tab in the
  attached profile and `camofox` gives you your own tab in its shared context
  on first use. This holds for a `tabId` you name on any page tool: another
  agent's tab, or the user's own tab, is refused and nothing runs there.
- **Ownership is per device and session when the caller forwards a session
  id, per device otherwise.** The owner key is `session:<device>:<session id>`
  when the client passes its session id (an agent spawned by agentproto does),
  and `device:<device>` when it does not (a desktop or chat app that reaches
  Bureau without a session id: all of them share one owner). So two agent
  sessions on one device are isolated from each other, but two callers that
  forward no session id can drive each other's tabs. Do not treat the owner as
  an isolation boundary unless your client forwards a session id.
- **Clean up.** Close your tabs with `browser_close_tab` when you are done.
- **No cookies.** Never read cookies: the call is refused. Use the account.
- **Consent is a human click.** `browser:awaiting_consent` means the user must
  click "Allow" in their browser. Report it and stop; do not retry in a loop.
- **A missing grant is not yours to create.** `browser:consent_required` means
  the account has no grant. Ask the user; agents cannot create one.
- **Writes need an explicit go.** Posting, sending, inviting or paying as the
  user needs the user's explicit confirmation, every time.

## Saved sessions: sign in again, credentials

These act on a saved camofox session by name (`account`, old name `session`),
not on a tab. A password is never an argument and never a result.

| Tool | Access | Use it when |
| --- | --- | --- |
| `session_reauth` | write | a saved session is `expired`: Bureau signs it in again headless from the credential stored on the host |
| `list_credentials` | read | you need to know which (platform, account) credentials are on file |
| `record_credential` | write, a human types the secret | no credential is on file and the user wants one stored |

- `session_reauth` answers `needs-human` on a 2FA prompt, a sign-in form still
  on the page, or no proof of a login, with the CLI command the user runs to
  finish by hand. It answers `no-credential` when nothing is stored: then call
  `record_credential`. It is rate limited: `session:reauth_limited` means stop
  retrying and hand the user the `command` (or wait for `retryAt`).
- `record_credential` returns the `bureau creds set` command for the user to
  run on the Bureau host, or with `via: "page"` opens a single-use form on that
  host. Either way the user types the password. Confirm with
  `list_credentials`.

## Workflows and their usage

`bureau_workflow_list` and `bureau_workflow_run` run the declarative workflows a
Bureau has registered. A priced workflow answers `needsApproval` until you
re-run it with `confirmPaid:true`, which is the user's go, never yours to assume.
`bureau_workflow_usage` (read only) reports per workflow how many runs there
were, the success rate, the failures by error code, the median duration and the
last run; filter it with `workflow`, `instance` or `since`. It holds no input or
output.

## The host screen (macOS, when enabled)

When the operator turned on screen control (`screen.enabled: true` in
`browsers.yaml`), Bureau also serves `screen_*` tools for desktop apps a
browser tool cannot reach. Prefer the browser tools for anything in a page.
Reads: `screen_capture` (use `mode: "global"`, the default, for coordinates),
`screen_displays`, `screen_windows`. Writes: `screen_move`, and `screen_click`
and a plain `screen_key` (no modifier, not return / enter), which take two
calls: first without `confirmToken` (a dry run that does nothing and returns a
token), then the same call with the token. A token works once, for 30 s, only
for you and only for that exact action. `screen_type`, and `screen_key` with a
modifier or on return / enter, need a person instead: the first call answers
`browser:approval_required` with a `requestId`; tell the user to approve it
(`bureau recipe approve <requestId>` or the approval card), then call again with
the same input and `approvalId`. Never retry in a loop while it is pending.
`screen:out_of_bounds` means the point is off the main display: take a fresh
global capture. `screen:killed` means the operator switched screen control
off: stop, do not retry. `screen:remote_refused` means Bureau cannot prove you
are a local caller and the operator keeps the screen local only
(`screen.allowRemote`): stop, do not retry. `screen:cliclick_missing` means the host needs
`brew install cliclick`. See `docs/screen-control.md`.

## Which browser for what

Read `browser_list_instances` and use the `purpose` field. Do not infer it from
this skill: purposes are local configuration.

## Driving your own Chrome on macOS

On macOS, attaching to the Chrome you already run needs `DevToolsActivePort`,
and the OS refuses that file to a background service. Install the tiny helper
once in your own Terminal:

```
bureau helper install --instance <name>
bureau helper status --instance <name>
bureau helper retry --instance <name>
bureau helper rename OLD NEW
bureau helper uninstall [--instance <name>] [--purge]
```

`install` compiles and signs the helper, loads its LaunchAgent, opens
System Settings > Privacy & Security > Full Disk Access, and reveals the helper
in a Finder window. Drag `bureau-port-helper` from that window into the Full
Disk Access list, then confirm with your password or Touch ID. The `+` button
and Cmd+Shift+G work too: paste the exact path install prints. With a terminal,
install waits for the grant (3 second checks, 5 minute timeout); `--wait` waits
without a terminal and `--no-wait` skips it. No Chrome restart is needed: if
Chrome is closed, the mirror appears when it starts. launchd starts the helper,
so the grant covers one file reader instead of every node script.

`status` reports the binary, signature, source hash, LaunchAgent, mirror
freshness and any EPERM in the helper log. When the log still shows EPERM, the
Full Disk Access entry is missing or points at another file: add the exact path
status prints, then run install again to redo the guided step. `retry` only
kickstarts the LaunchAgent and reports the mirror state. `rename` moves the
LaunchAgent to a new declared name without touching the shared binary or
mirror. `uninstall` removes the LaunchAgent and its own mirror but keeps the
shared binary, build stamp, log and `ports/`; `--purge` removes those too when
no other helper remains. The Full Disk Access grant is tied to the binary, so a
rebuild means granting it again by hand.

If Chrome shows an "Allow" prompt for a new debugging client, the instance row
reports `browser:awaiting_consent`: click Allow, then retry once. A mirror older
than Chrome's own file is reported as `browser:attach_stale_mirror`; run
`bureau helper install` to reload the LaunchAgent, then `bureau helper retry`.

When `browsers.yaml` declares several instances, mark one `default: true`. With
none flagged, Bureau never silently makes an attach entry on your real Chrome
directory the default: it skips it and uses the next declared instance. If no
safe candidate is left, a call without `instance` fails and lists the names.

## References

| File | Read it for |
| --- | --- |
| `reference/transport.md` | the Bureau MCP endpoint, pairing, sub-session token |
| `reference/capture.md` | screenshots and selective text capture |
| `reference/recon.md` | finding and driving a site's internal API |
| `reference/writes.md` | gated write discipline and rate limits |
| `reference/accounts-and-grants.md` | accounts, session states, grants, consent |

## Site recipes

Site knowledge (internal APIs, entities, gotchas per site) is not part of this
skill. It ships separately as recipes. For work on a specific site, call
`browser_list_recipes` first, then `browser_recipe_guide` for the section you
need. Without a recipe for a site, use `reference/recon.md` to find and drive
its internal API.

## Golden rules

1. **API first for data.** Read the site's own internal API from inside the
   authenticated page; the DOM is the slow, obfuscated surface. News and
   content sites are the exception: there the content is the HTML. See
   `reference/recon.md`.
2. **Fail fast.** Give a page about 8 seconds, not 60. A hang past 5 or 6
   seconds rarely recovers.
3. **Prefer direct navigation.** Navigate to the URL instead of clicking a link
   that navigates.
4. **Capture cheaply.** Text and JSON for data, screenshots only for pixels.
   See `reference/capture.md`.
5. **Gate every write.** It acts as the user. See `reference/writes.md`.
