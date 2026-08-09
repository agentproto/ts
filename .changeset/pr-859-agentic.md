---
agentproto-vscode: minor
---

Wallet-first revamp of auth-related UI surfaces. Auth Profiles webview renamed to "Wallets" and refactored to group profiles by provider via the Auth & Model Map's single-source-of-truth `buildProviders()`/`accessKind()` logic — eliminating duplicate classification across four surfaces. Harnesses webview now displays manifest facts (interface spoken, route, base_url acceptance) and per-provider reach via `buildAuthModel()`, ensuring parity with the map. Auth Settings consolidated into Wallets view for curation editing and model removal, leaving Auth Settings as a redirector to the two surfaces that replaced it. All mutation flows (connect, enable, disable, delete, set models) use only existing DaemonClient endpoints.
