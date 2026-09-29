---
"@agentproto/driver-browser": minor
---

Add the F11 profile guard: `BrowserProfileRefusedError` (code `browser:profile-refused`), `resolveDedicatedProfileDir`, `isDefaultChromeUserDataDir`, `assertNoOwnedArgs`, `assertSpawnArgsSafe` and `liveProfileLockPid`, so providers never launch against or attach to a default Chrome user-data-dir. Add the cookie helpers `browserCookieSchema`, `cookiesFromSessionPayload` and the `BrowserCookieSource` type. `runConformance` now passes `fixture.url` as `initialUrl` when it attaches each level's driver.
