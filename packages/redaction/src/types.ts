/**
 * Vendor-neutral Redactor port.
 *
 * This package OWNS the redaction contract so any egress boundary (loggers,
 * telemetry sinks, session tracers) can depend on a single interface without
 * pulling in a kernel. It is a LEAF — it imports nothing from a runtime;
 * runtimes depend on IT. No network, no credentials in v1: every built-in
 * redactor here is a pure, local transform.
 *
 * Being "off by default" is the CONSUMER's job — this package only provides
 * the transforms; a tracer or logger decides whether and how to apply one.
 *
 * Future work (OUT of this package for v1): external/PII-detection providers
 * (e.g. Presidio) would resolve over the network and carry `needsCreds: true`
 * in {@link RedactorCatalogEntry}. None are included here.
 */

/** Recursive JSON value, defined locally so the package stays dependency-free. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | { readonly [key: string]: JsonValue }
  | readonly JsonValue[]

/** Which part of an outbound payload is being redacted. */
export type RedactionField =
  | "prompt"
  | "input"
  | "output"
  | "tool-args"
  | "tool-result"
  | "metadata"

/** Context passed to a redactor alongside the value it is scrubbing. */
export interface RedactionContext {
  readonly field: RedactionField
  readonly sessionId?: string
}

/** A pluggable transform applied to an outbound payload before it leaves the process. */
export interface Redactor {
  readonly slug: string
  redact(value: JsonValue, ctx: RedactionContext): JsonValue
}

/** A catalog entry describing a buildable redactor backend. */
export interface RedactorCatalogEntry {
  readonly slug: string
  readonly description: string
  readonly needsCreds: boolean
  build(options?: JsonValue): Redactor
}

/**
 * Declarative spec resolved to a {@link Redactor} by {@link resolveRedactor}.
 * A string is a bare catalog slug; an object carries per-slug options; an
 * array chains multiple specs in order (each spec's output feeds the next).
 */
export type RedactorSpec =
  | string
  | { readonly slug: string; readonly options?: JsonValue }
  | readonly RedactorSpec[]
