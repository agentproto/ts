/**
 * agentgovernance/v1 renderers — thin wrappers over canvakit templates.
 *
 * Each renderer exposes:
 *   - A canonical template id (e.g., `governance.signing-portal`)
 *   - The bundled template file path (relative to the package root)
 *   - A typed variables schema + builder
 *
 * Apps wire the template id to their canvakit renderer of choice
 * (e.g., @canvakit/core's mustache engine). This package does NOT depend on
 * canvakit at runtime — only on the spec for template ids + variable shapes.
 *
 * Phase 1: signing-portal (used for typed_name signing UX).
 * Phase 4: signature-card, audit-timeline, policy-summary.
 */

export {
  SIGNING_PORTAL_TEMPLATE_ID,
  SIGNING_PORTAL_TEMPLATE_PATH,
  signingPortalVariablesSchema,
  signingPortalVariables,
  type SigningPortalVariables,
} from "./signing-portal.js"

export {
  SIGNATURE_CARD_TEMPLATE_ID,
  SIGNATURE_CARD_TEMPLATE_PATH,
} from "./signature-card.js"

export {
  AUDIT_TIMELINE_TEMPLATE_ID,
  AUDIT_TIMELINE_TEMPLATE_PATH,
} from "./audit-timeline.js"

export {
  POLICY_SUMMARY_TEMPLATE_ID,
  POLICY_SUMMARY_TEMPLATE_PATH,
} from "./policy-summary.js"
