---
"@agentproto/adapter-browser-chromium": minor
"@agentproto/adapter-browser-chrome": minor
"@agentproto/adapter-browser": minor
---

New `@agentproto/adapter-browser-chromium`: a `chromium` provider that drives Playwright Chromium on its own dedicated profile dir, with an idempotent `launch()`, CDP endpoint, network capture with response bodies, screenshots and cookie injection. `playwright-core` is loaded lazily, so importing the package needs no browser; install one with `npx playwright install chromium`.

New `@agentproto/adapter-browser-chrome`: a `chrome` provider that finds the system Chrome (`CHROME_EXECUTABLE_PATH`, then the standard per-OS paths), launches it with `--remote-debugging-port=0` on a fresh dedicated user-data-dir, attaches over CDP and injects granted cookies through `Network.setCookies` (the cookie source is a parameter).

Both providers never use the default Chrome user-data-dir (Chrome 136+ refuses the debugging port there). A request for it, for a real profile name, for `--full-profile`, or for a `--user-data-dir` / `--remote-debugging-*` override is refused with the typed error `browser:profile-refused`.

`@agentproto/adapter-browser`: the `chromium` facade id is now backed by the real Playwright provider instead of managing a service process. `resolveCmd` stays exported. `browserAdapters`, `getBrowserAdapter` and `toAdapterHandle` keep their shape. The `chromium` manifest now prompts for `CHROMIUM_EXECUTABLE_PATH` instead of `CHROMIUM_SERVE_CMD`.
