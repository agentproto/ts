---
"@agentproto/secrets": major
"@agentproto/runtime": major
"@agentproto/cli": major
---

Retire pair/v1 with a route/auth token split (pair/v2): broker-visible tokens no longer authenticate; a distinct sealed-hello auth token is checked instead. v1 offers, pairings, credentials, and wire hellos are refused with an actionable `pairing_protocol_outdated` re-pair error, and daemons answer legacy v1 hellos with a notice-only re-pair channel. Breaking: `PAIR_VERSION` 2, `ClientHandshakeParams.offerToken`→`authToken`, `PairingOffer.token`→`secret`, `verifyOfferToken`→`verifyAuthToken`, `CreatedOffer.token`→`secret`, pairing/credentials files version 2 (v1 files load flagged `legacy`), new exports `respondToLegacyHandshake`, `deriveEpochAuthToken`, `deriveEpochTokens`, `deriveOfferTokens`, `RouteAuthTokens`.
