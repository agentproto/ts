# agentgovernance/v1 — Hash-chain Protocol

> **Spec status:** alpha (1.0.0-alpha) · governance.sh · MIT
>
> This document defines the wire format and chain construction rules for the
> `audit-log.jsonl` doctype of `agentgovernance/v1`. Third-party implementations
> in any language can be built directly from this document. The reference
> implementation is
> [@agentproto/governance](https://npmjs.com/package/@agentproto/governance)
> (TypeScript, Node.js).

## 1. Overview

An audit log is an append-only file `<scope>/audit/audit-log.jsonl`. Each line
is a single JSON object — one audit event. Adjacent lines are linked by an
HMAC-SHA256 chain so that:

- **Tampering** with any past line invalidates every subsequent signature.
- **Reordering** lines invalidates the chain.
- **Inserting** or **deleting** lines invalidates the chain.
- A **verifier** with only the file + a workspace genesis seed + the HMAC secret
  can prove the log is intact end-to-end without any infrastructure.

## 2. Required line shape

Every line MUST be a single JSON object containing at least these fields:

```json
{
  "schema": "agentgovernance/v1",
  "doctype": "audit-event",
  "actorKind": "operator",
  "actorId": "jeremy",
  "entityType": "signature",
  "entityId": "engagements/2026-acme/signatures/acme-corp-2026-04-15.signature.json",
  "action": "signature.created",
  "prevSignature": "<64-char lowercase hex>",
  "signature": "<64-char lowercase hex>",
  "createdAt": "2026-04-15T10:23:45.000Z"
}
```

Additional fields permitted (see `audit-event.ts` for the full zod schema).

## 3. Chain construction

### 3.1 Genesis seed

Each workspace has a **genesis seed**: a 64-character lowercase hex string (256
bits) generated when the workspace is initialized. The seed MUST be stored
outside the workspace (vault, secrets manager) and never committed.

The seed is used as `prevSignature` for the **first** line of every
`audit-log.jsonl` file in the workspace.

### 3.2 HMAC secret

A workspace has an **HMAC secret** (any string of sufficient entropy; ≥256 bits
recommended). The secret is used as the HMAC key for every signature. The secret
MUST be stored outside the workspace.

The genesis seed and HMAC secret MAY be the same value, but separating them is
recommended.

### 3.3 Canonical bytes

Before hashing, a row is canonicalized to a deterministic byte sequence:

1. **Drop the `signature` field** from the row.
2. Recursively serialize:
   - `null` → `null`
   - `true` / `false` → `true` / `false`
   - Numbers → JSON.stringify representation. Non-finite numbers (`NaN`,
     `±Infinity`) are NOT representable.
   - Strings → JSON-encoded string (RFC 8259 string escaping).
   - Arrays → `[v1,v2,...]` with values canonicalized in-order.
   - Objects → `{"k1":v1,"k2":v2,...}` with **keys sorted lexicographically by
     Unicode code point**, `undefined` values dropped, values canonicalized
     recursively.
3. Output as **UTF-8 bytes**, no whitespace.

This is a strict subset of
[RFC 8785 (JCS)](https://datatracker.ietf.org/doc/html/rfc8785). Implementations
SHOULD support the full RFC 8785 rules; they MUST at least support the subset
described here for `agentgovernance/v1` interop.

### 3.4 Signature computation

```
signature_n = HMAC-SHA256(
  key  = secret_bytes,
  data = prev_signature_hex_utf8 ‖ canonical_bytes(row_n_without_signature)
)
```

Where `prev_signature_hex_utf8` is the previous line's `signature` field (or the
workspace genesis seed for line 0) **as the UTF-8 encoding of the 64 hex
characters** (i.e., 64 bytes, not 32 raw hash bytes).

The output is a 32-byte HMAC, encoded as 64 lowercase hex characters and stored
as the line's `signature` field.

### 3.5 Inserting a new line

To append a new event to the log:

1. Read the previous line's `signature` (or the genesis seed if the file is
   empty).
2. Build the row WITHOUT the `signature` field, but WITH the `prevSignature`
   field equal to the previous signature.
3. Compute
   `signature_n = HMAC-SHA256(secret, prevSignature_utf8 ‖ canonical(row_without_signature))`.
4. Add the `signature` field to the row.
5. Append the JSON-encoded row + `\n` to the file.

## 4. Verification

A verifier walks the file line by line:

1. Initialize `expected_prev = genesis_seed`.
2. For each non-empty line:
   1. Parse JSON.
   2. Assert `row.prevSignature === expected_prev`. Otherwise: chain forked /
      lines reordered.
   3. Compute
      `computed = HMAC-SHA256(secret, row.prevSignature_utf8 ‖ canonical(row_minus_signature))`.
   4. Assert `computed === row.signature`. Otherwise: row tampered.
   5. Set `expected_prev = computed`.
3. Report ok with `verifiedLines` count and the final `signature` (anchor
   candidate).

## 5. External anchors

Periodically (default: every 1000 lines), the latest `signature` is published to
an external sink:

- An **S3 object with object-lock** (compliance-mode) — provides a
  tamper-evident anchor.
- A **transparency log** (e.g., Sigstore's Rekor, or a self-hosted Trillian).
- A **public Git commit** in a separate repo with branch protection.

A workspace cannot rewrite history without invalidating an external anchor. The
anchor is the chain-of-custody bridge between filesystem files and an immutable
external witness.

Anchor receipts MAY be stored at
`<scope>/audit/anchors/<line-index>.anchor.json` for retrievability.

## 6. Reference test vectors

> **Status:** tested against the TypeScript reference implementation in
> @agentproto/governance. Other implementations SHOULD produce identical
> signatures given identical inputs.

### 6.1 Single-line chain

```
genesis_seed = "0000000000000000000000000000000000000000000000000000000000000000"
secret = "test-secret"

row_0_without_signature = {
  "schema": "agentgovernance/v1",
  "doctype": "audit-event",
  "actorKind": "system",
  "actorId": null,
  "entityType": "audit-event",
  "entityId": "test:genesis",
  "action": "log.initialized",
  "prevSignature": "0000000000000000000000000000000000000000000000000000000000000000",
  "createdAt": "2026-01-01T00:00:00.000Z"
}

canonical_bytes (UTF-8) =
  {"action":"log.initialized","actorId":null,"actorKind":"system","createdAt":"2026-01-01T00:00:00.000Z","doctype":"audit-event","entityId":"test:genesis","entityType":"audit-event","prevSignature":"0000000000000000000000000000000000000000000000000000000000000000","schema":"agentgovernance/v1"}

signature_0 = HMAC-SHA256("test-secret",
  "0000...0000" (64 ASCII bytes) ‖ canonical_bytes)

= <computed at test time; recorded in test/fixtures/vectors.json>
```

The exact signature value is generated and frozen in the test fixtures
(`test/fixtures/hash-chain/vectors.json`) so any implementation can verify
byte-for-byte compatibility.

### 6.2 Tampering test

Mutating any field in row_M (other than `signature` itself) MUST cause the
verifier to report `signature_mismatch` at line M.

Removing line M MUST cause the verifier to report `prev_signature_mismatch` at
line M+1.

## 7. Versioning

This protocol is `agentgovernance/v1` chain version `1.0.0-alpha`. Future
versions MAY:

- Switch the primitive (e.g., HMAC-SHA3, BLAKE3, Ed25519 signatures over
  canonical bytes for non-repudiation).
- Adjust canonicalization rules (e.g., full RFC 8785 mandatory).

A workspace MUST emit a single chain version per file. Mixing versions in one
log is forbidden. To upgrade, close out the existing log with a final anchor +
start a new log file under a new path.

## 8. Security notes

- The HMAC secret leaking compromises **future** writes (an attacker can forge
  new signatures) but does **not** compromise past entries that have been
  externally anchored.
- The genesis seed is a public-by-design value; protect it via vault but do not
  rely on its secrecy for integrity.
- HMAC-SHA256 provides ~256-bit collision resistance; suitable for the
  foreseeable future.
- Rotating the HMAC secret requires closing the current log + starting a new one
  (no rekeying within a single chain).

## 9. Reference implementation

[@agentproto/governance](https://npmjs.com/package/@agentproto/governance) —
TypeScript / Node.js reference implementation. See
`src/spec/hash-chain/{compute,verify}.ts`.

Test vectors are committed at `test/fixtures/hash-chain/vectors.json`. Any
implementation passing these vectors is interoperable with the reference.
