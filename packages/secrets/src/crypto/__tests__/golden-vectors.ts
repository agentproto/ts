/**
 * Golden vectors captured from the PRE-refactor, `node:crypto`-only build of
 * `@agentproto/secrets` (commit 98084516, the sync `Buffer` implementation),
 * with its randomness pinned: `generateKeyPairSync("x25519")` was patched to
 * hand out the fixed keys below in call order, and `randomBytes(12)` to return
 * twelve 0x5a bytes (patched on `node:crypto`, then `syncBuiltinESMExports()`).
 *
 * `golden.test.ts` replays the same inputs through the refactored code with
 * each `CryptoProvider` and requires byte-for-byte equality — the proof that
 * the provider seam changed nothing on the wire or in the key schedule.
 *
 * Test data only: these keys protect nothing.
 */

export const KEYS = {
  "daemonX": {
    "pub": "MCowBQYDK2VuAyEA9g736kFg03Iq76wRWkotIp2nMvizVOFK8CJUNqNqSX8=",
    "priv": "MC4CAQAwBQYDK2VuBCIEINCb5jNG/nQ6EID4nZ0A8NJBunSYCntWk/BhUr41ySRb"
  },
  "daemonEd": {
    "pub": "MCowBQYDK2VwAyEABT4L+Suyw4ZE23lVR/j5EEccBI/UG0umjd8vrdIMmm0=",
    "priv": "MC4CAQAwBQYDK2VwBCIEID4BeaIrGjZ47YwkJh3I5/1/thUWK5UePjCmDy9DQHeE"
  },
  "clientEph": {
    "pub": "MCowBQYDK2VuAyEAo9dEfjHKYJvYKfiEreVUWGHdjkU+vh57Gp3GWsMJKDw=",
    "priv": "MC4CAQAwBQYDK2VuBCIEIGDTCFj+wnd0HoTOeQneR2DfPxny0lpbfx72LIG8MxR4"
  },
  "sealEph": {
    "pub": "MCowBQYDK2VuAyEAlHKe3waWMx88JSwc0A4tLflxPuDivEO4jX8+WuCpVhU=",
    "priv": "MC4CAQAwBQYDK2VuBCIEIAiklyl5x6NOE+ceDmQxgGpH9Rl8RnTzbYaEiXz4YXtE"
  },
  "daemonEph": {
    "pub": "MCowBQYDK2VuAyEAx1GZFWBLMBqdB1P+ZP2xke5jyW3rzu8PyCHqY/M4fSM=",
    "priv": "MC4CAQAwBQYDK2VuBCIEIMir0klq8owtm4aFKPyxiMptE+w8ywjrjLfQ4bDPltZq"
  }
} as const

export const GOLDEN = {
  "helloWire": "{\"v\":1,\"ePub\":\"MCowBQYDK2VuAyEAo9dEfjHKYJvYKfiEreVUWGHdjkU+vh57Gp3GWsMJKDw=\",\"ct0\":\"eyJ2IjoxLCJhbGciOiJ4MjU1MTktaGtkZi1zaGEyNTYtYWVzMjU2Z2NtIiwiZXBrIjoiTUNvd0JRWURLMlZ1QXlFQWxIS2Uzd2FXTXg4OEpTd2MwQTR0TGZseFB1RGl2RU80alg4K1d1Q3BWaFU9IiwiaXYiOiJXbHBhV2xwYVdscGFXbHBhIiwiY3QiOiJQMGJ5N3pRdTRkRWhmSjNQNUtzYW5FVTBCcWc1ZGhyMmxDSDQwVGIwNmlKeWZEWDNBbHFCMDdha3FXNmVJV05CNnpuNFlIWmJ4UXk5bHVDY3ZPdTFXK216ZlNuNGNnR2xqWTY1ZGZHUXZQVTlpd3ZBS3N5Zm1oNnVyR3E0eWc3TG1BSzNNdlRJRGlhekdOMGljOHU3NXVwKzQ3QitESzBKdGMyMlVyaHFDRU13NE1STkZiUk1NVTYxUHlreWtNRT0iLCJ0YWciOiJ2Z0ZiUjZLZ0FGdlZoNG5YSmpqa1ZBPT0ifQ==\"}",
  "replyWire": "{\"v\":1,\"dePub\":\"MCowBQYDK2VuAyEAx1GZFWBLMBqdB1P+ZP2xke5jyW3rzu8PyCHqY/M4fSM=\",\"sig\":\"K3RR3iQArALVFvAvfRw5EeQYDUiviAjkiWozyKHbMlihiZ4iBplsD05RF+aWXvl096xpBPZqZFwutSpRdXT3Dg==\"}",
  "clientSendKey": "e53b251d2c6c89c08bf77ba5c0f8902a6f017afa0d959f920eea91145813df12",
  "clientRecvKey": "7d5f598bfc729afc83809ac891562b6fc8ebfbdc455c98197adc5db79b9d3ff2",
  "daemonSendKey": "7d5f598bfc729afc83809ac891562b6fc8ebfbdc455c98197adc5db79b9d3ff2",
  "daemonRecvKey": "e53b251d2c6c89c08bf77ba5c0f8902a6f017afa0d959f920eea91145813df12",
  "transcriptHash": "abc9c0349676f8e79f744528c31e13404396f9db87a31bd0895709a4d9b61121",
  "clientPeerFingerprint": "3618963fe733bf15",
  "daemonPeerFingerprint": "0930400eedbcdaf8",
  "pairRoot": "KKf8y+HzsKOPnW+2t7hY0r0V5Q/d7VIxzO+lKgx8IXw=",
  "epochToken20000": "_qxhZWUGUgTzFsNsbv1Alw",
  "sealed": "eyJ2IjoxLCJhbGciOiJ4MjU1MTktaGtkZi1zaGEyNTYtYWVzMjU2Z2NtIiwiZXBrIjoiTUNvd0JRWURLMlZ1QXlFQWxIS2Uzd2FXTXg4OEpTd2MwQTR0TGZseFB1RGl2RU80alg4K1d1Q3BWaFU9IiwiaXYiOiJXbHBhV2xwYVdscGFXbHBhIiwiY3QiOiJJd3Y5NXpnbHI5VWRhSmFEcXV3dnF3cWgyR289IiwidGFnIjoiRjdmRGI5MEZPR3dlL09rcXVBMzczQT09In0=",
  "tunnelOfferWire": "{\"v\":1,\"ePub\":\"MCowBQYDK2VuAyEAx1GZFWBLMBqdB1P+ZP2xke5jyW3rzu8PyCHqY/M4fSM=\",\"mac\":\"WKgdjAXuUJVGpFgVmy8iXOQHrbNHquGnSYEVp69/J9k=\"}",
  "tunnelAcceptWire": "{\"v\":1,\"ePub\":\"MCowBQYDK2VuAyEAo9dEfjHKYJvYKfiEreVUWGHdjkU+vh57Gp3GWsMJKDw=\",\"mac\":\"yaGPGCgqzhIIUnAUs1lccKT3ymzYmQrT0LgnmXcBN0s=\"}",
  "tunnelDaemonSendKey": "037be76bd4157d2852221b63a20cada90dd4e964def3403be0c91b7057130f3f",
  "tunnelDaemonRecvKey": "f6077202338de27a0e6b8b07c129b39f308605e39b4528155cf5cae91f7a502e",
  "tunnelHostSendKey": "f6077202338de27a0e6b8b07c129b39f308605e39b4528155cf5cae91f7a502e",
  "tunnelTranscriptHash": "752f02641d3584c51874c1dbc70c52df4790337a8b92abcf85222eb17439e9c0",
  "offerUrl": "agentproto://pair?v=1&rv=wss%3A%2F%2Frdv.example%2Fv1&id=3618963fe733bf15&pk=MCowBQYDK2VuAyEA9g736kFg03Iq76wRWkotIp2nMvizVOFK8CJUNqNqSX8&sk=MCowBQYDK2VwAyEABT4L-Suyw4ZE23lVR_j5EEccBI_UG0umjd8vrdIMmm0&t=AAAABBBBCCCCDDDDEEEEFF&exp=1900000000"
} as const

/**
 * pair/v2 known-answer vectors (route/auth split). Same pinned inputs as
 * above: offer secret "AAAABBBBCCCCDDDDEEEEFF", keys from `KEYS`, 0x5a random
 * bytes. The four token derivations were checked against an independent
 * RFC 5869 HKDF-SHA256 (Python `hmac`), not only this code. `epochRoute20000`
 * derives from the v1 `GOLDEN.pairRoot` and equals v1's `epochToken20000` on
 * purpose: the reconnect ROUTE is unchanged, only the proof moved.
 */
export const GOLDEN_V2 = {
  "helloWire": "{\"v\":2,\"ePub\":\"MCowBQYDK2VuAyEAo9dEfjHKYJvYKfiEreVUWGHdjkU+vh57Gp3GWsMJKDw=\",\"ct0\":\"eyJ2IjoxLCJhbGciOiJ4MjU1MTktaGtkZi1zaGEyNTYtYWVzMjU2Z2NtIiwiZXBrIjoiTUNvd0JRWURLMlZ1QXlFQWxIS2Uzd2FXTXg4OEpTd2MwQTR0TGZseFB1RGl2RU80alg4K1d1Q3BWaFU9IiwiaXYiOiJXbHBhV2xwYVdscGFXbHBhIiwiY3QiOiJQMGJ5N3pRdTRkRWhmSjNQNUtzYW5FVTBCcWc1ZGhyMmxDSDQwVGIwNmlKeWZEWDNBbHFCMDdha3FXNmVJV05CNnpuNFlIWmJ4UXk5bHVDY3ZPdTFXK216ZlNuNGNnR2xqWTY1ZGZHUXZQVTlpd3ZBS3N5Zm1oNnVyR3E0eWc3TG1BSzNNdlRJRGlhekdOTXhZY2JyaUtkQXlaTTBXdVVoanYvQ1ZJNUhHUzBsanNOUUI2RmlOVHJHS0NrTTRmbFVydE9KMFJSeU42Z2J6ZkY5WDVrPSIsInRhZyI6IjBNQVM5bmNRNVd3cVZaSzdBb0tEb3c9PSJ9\"}",
  "replyWire": "{\"v\":2,\"dePub\":\"MCowBQYDK2VuAyEAx1GZFWBLMBqdB1P+ZP2xke5jyW3rzu8PyCHqY/M4fSM=\",\"sig\":\"wcTzXaVNoViwHa9f8NobdgydUZVqC0kO3I3cDQIrhH0BxaDqxnTAywBsb6fqTg8sAi8BQZrZVNpvNOU/qyYdBA==\"}",
  "clientSendKey": "b72b45a1057f1d25b4a57e91c340d5c9dd7c566c9c372dfbe0fa6ad9dc62837f",
  "clientRecvKey": "57183bc876818760b9f27280a568f884e2248fca53bc5d9a99d3fab22f2c24f2",
  "transcriptHash": "9e3225b75f1a34817ee1ee255a9b3c209169a4f752e1f1918b6237dbd191e502",
  "pairRoot": "bYFP4u3plI2gyB8GmVs6UBXRAyun1Rb24bclG2dNi1k=",
  "offerRoute": "G8SO5JOFLKZDqugteQRpFw",
  "offerAuth": "UOMhljizs5DtoS-V-DYVQjA16RFxSEjLIvoWrBTw7ZI",
  "epochRoute20000": "_qxhZWUGUgTzFsNsbv1Alw",
  "epochAuth20000": "uXAlKAr1zp4L0hDl1VzXDdc9QsOh0rIYK4ijWsZaocQ",
  "offerUrl": "agentproto://pair?v=2&rv=wss%3A%2F%2Frdv.example%2Fv1&id=3618963fe733bf15&pk=MCowBQYDK2VuAyEA9g736kFg03Iq76wRWkotIp2nMvizVOFK8CJUNqNqSX8&sk=MCowBQYDK2VwAyEABT4L-Suyw4ZE23lVR_j5EEccBI_UG0umjd8vrdIMmm0&s=AAAABBBBCCCCDDDDEEEEFF&exp=1900000000"
} as const
