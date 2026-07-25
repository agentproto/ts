---
agentproto-vscode: minor
---

Add support for explicit authentication headers in daemon client configuration. Enables cookie-based and other auth schemes (e.g., for attached sandbox authentication) via the new `agentproto.authHeaders` setting, which takes precedence over bearer tokens.
