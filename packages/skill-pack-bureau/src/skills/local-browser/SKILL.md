---
name: local-browser
description:
  Drive the user's real, authenticated Chrome from an agentproto-connected
  client. Use when a task needs the user's live cookies, sessions, or
  extensions (Gmail, LinkedIn, GitHub, ad managers, internal tools)
  rather than a fresh anonymous browser.
metadata:
  tags: browser, chrome, mcp, agentproto, local-browser, chrome-devtools
---

## When to use

Reach for this skill whenever the task needs to act AS THE USER in a
web context. The hallmark is: an unauthenticated browser can't do this
because the page requires their cookies/session.

- "Post this to LinkedIn / Twitter / Reddit" — needs their logged-in
  session.
- "Check my Gmail / Slack / Linear for X" — same.
- "Pull this from <internal admin tool> behind SSO."
- "Place this order on Amazon / book this flight" — payment + saved
  cards + addresses.
- "Comment on this PR / file this Jira ticket" — authored as them.

If the page is public and unauthenticated, prefer a regular fetch /
plain scraping tool — driving a real browser is overkill and the
cookies are sensitive.

## What it is

The `local-browser` plugin (`@agentproto/plugin-local-browser`) is a
one-time setup that:

1. Clones one of the user's existing Chrome profiles into
   `~/.agentproto/chrome-profile/` (cookies + extensions + logins
   transfer).
2. Installs `chrome-devtools-mcp` into `~/.agentproto/chrome-mcp/`.
3. Registers it in `~/.agentproto/imported-mcps.json` so the
   agentproto daemon proxies all 29 browser tools through `/mcp` to
   every tunnel-connected client.

The daemon spawns Chrome on demand against the cloned profile, so the
user's daily Chrome keeps running undisturbed.

## How to call it

Tools surface under the alias `local-browser`. From an agentproto
MCP-proxy client they're invoked via the daemon's meta-tools:

```jsonc
// list everything available
mcp_imported_tool_list({ alias: "local-browser" })

// drive the browser
mcp_imported_call({
  alias: "local-browser",
  tool: "navigate_page",
  arguments: { url: "https://news.ycombinator.com" }
})
```

The 29 tools fall into these buckets:

| What you want                  | Tool(s)                                                             |
|--------------------------------|---------------------------------------------------------------------|
| Open / switch pages            | `new_page`, `navigate_page`, `select_page`, `list_pages`, `close_page` |
| See the page                   | `take_snapshot` (AX tree), `take_screenshot`, `list_console_messages` |
| Click / type / fill            | `click`, `type_text`, `fill`, `fill_form`, `press_key`, `hover`, `drag` |
| Wait for something             | `wait_for`                                                          |
| Run JS                         | `evaluate_script`                                                   |
| Network inspection             | `list_network_requests`, `get_network_request`                      |
| Perf / Lighthouse              | `performance_start_trace`, `performance_stop_trace`, `lighthouse_audit` |
| Files / dialogs / viewport     | `upload_file`, `handle_dialog`, `resize_page`, `emulate`            |

A typical flow:

1. `navigate_page` to the target URL.
2. `take_snapshot` — returns an AX tree where each element has a
   `uid`.
3. Pass that `uid` to `click` / `fill` / etc. (do NOT pass CSS
   selectors).
4. `wait_for` if the next step depends on a network response or DOM
   change.
5. `take_screenshot` if you need to show the user what happened.

## How to know it's installed

If `mcp_imported_status` doesn't list a `local-browser` import, the
user hasn't set the plugin up yet. Suggest:

```bash
npx -y -p @agentproto/plugin-local-browser agentproto-browser setup
```

Then the user restarts the daemon (`~/.agentproto/start-daemon-prod.sh`)
and the tools appear on the next `mcp_imported_status`.

## Safety rails

The plugin drives a Chrome signed into the user's accounts. That means:

- **Don't speculatively click things.** Each call may post, pay, send,
  or delete with the user's identity. Always state what you're about
  to do and get explicit confirmation for irreversible actions.
- **Don't run `evaluate_script` with anything that could exfiltrate**
  (`document.cookie`, localStorage dumps, etc.) without an extremely
  clear ask. The result returns through the daemon → MCP → wherever
  you are.
- **Sessions are real but a snapshot.** Logins set up at clone-time
  may have expired; if a page redirects to a login screen, fall back
  to "please sign in here once" rather than trying to fill credentials.
- **Treat screenshots like screenshares.** They can reveal unrelated
  open tabs, account names, notifications. Show only what the user
  asked for and crop when you can.
