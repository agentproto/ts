/**
 * Renderer wrapper for the `governance.signature-card` canvakit template.
 *
 * Stub — Phase 4. Will display a single signature event as a compact card
 * (signer, method, timestamp, document hash truncated, evidence summary).
 *
 * For now, callers MAY render their own UI directly from a Signature object.
 */

export const SIGNATURE_CARD_TEMPLATE_ID = "governance.signature-card" as const

export const SIGNATURE_CARD_TEMPLATE_PATH =
  "src/spec/canvakit-templates/governance.signature-card/template.canvakit.html" as const

// TODO(phase-4): implement template + variables schema.
