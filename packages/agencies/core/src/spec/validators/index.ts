/**
 * agentagencies/v1 validators.
 *
 * Per-doctype validators take file content (markdown string for *.md, JSON
 * string for *.json) and return typed ValidationResult. Cross-doctype
 * consistency checks live alongside.
 *
 * Validators do NOT touch the filesystem — callers pass file contents in.
 * For FS-aware orchestration, see `../../runtime/`.
 */

import type { z } from "zod"
import matter from "gray-matter"

import { agencyFrontmatterSchema, type Agency } from "../doctypes/agency.js"
import {
  operationsFrontmatterSchema,
  type Operations,
} from "../doctypes/operations.js"
import { serviceFrontmatterSchema, type Service } from "../doctypes/service.js"
import {
  procedureFrontmatterSchema,
  type Procedure,
} from "../doctypes/procedure.js"
import {
  pricingModelFrontmatterSchema,
  type PricingModel,
} from "../doctypes/pricing-model.js"
import {
  counterpartyFrontmatterSchema,
  type Counterparty,
} from "../doctypes/counterparty.js"
import {
  engagementFrontmatterSchema,
  type Engagement,
} from "../doctypes/engagement.js"
import {
  agreementFrontmatterSchema,
  type Agreement,
} from "../doctypes/agreement.js"
import {
  deliverableFrontmatterSchema,
  type Deliverable,
} from "../doctypes/deliverable.js"
import { invoiceFrontmatterSchema, type Invoice } from "../doctypes/invoice.js"
import { routineFrontmatterSchema, type Routine } from "../doctypes/routine.js"
import {
  capacityFrontmatterSchema,
  type Capacity,
} from "../doctypes/capacity.js"

export type ValidationResult<T = unknown> =
  | { ok: true; value: T; warnings: string[] }
  | { ok: false; errors: ValidationError[]; warnings: string[] }

export interface ValidationError {
  path: string[]
  message: string
  code?: string
}

function fromZodError(err: z.ZodError): ValidationError[] {
  return err.issues.map(issue => ({
    path: issue.path.map(p => String(p)),
    message: issue.message,
    code: issue.code,
  }))
}

function err(
  message: string,
  code: string,
  path: string[] = []
): ValidationError[] {
  return [{ path, message, code }]
}

// Generic frontmatter-doctype validator factory — DRY across the 12 doctypes.
function makeFrontmatterValidator<
  TFm,
  TDoc extends { frontmatter: TFm; body: string },
>(schema: z.ZodType<TFm>): (markdown: string) => ValidationResult<TDoc> {
  return (markdown: string) => {
    let parsed: ReturnType<typeof matter>
    try {
      parsed = matter(markdown)
    } catch (e) {
      return {
        ok: false,
        errors: err(
          `Frontmatter parse error: ${(e as Error).message}`,
          "parse_error"
        ),
        warnings: [],
      }
    }
    const result = schema.safeParse(parsed.data)
    if (!result.success) {
      return {
        ok: false,
        errors: fromZodError(result.error).map(e => ({
          ...e,
          path: ["frontmatter", ...e.path],
        })),
        warnings: [],
      }
    }
    return {
      ok: true,
      value: { frontmatter: result.data, body: parsed.content } as TDoc,
      warnings: [],
    }
  }
}

// ─── Per-doctype validators (12 of them) ──────────────────────────────

export const validateAgency = makeFrontmatterValidator<
  typeof agencyFrontmatterSchema._zod.output,
  Agency
>(agencyFrontmatterSchema)
export const validateOperations = makeFrontmatterValidator<
  typeof operationsFrontmatterSchema._zod.output,
  Operations
>(operationsFrontmatterSchema)
export const validateService = makeFrontmatterValidator<
  typeof serviceFrontmatterSchema._zod.output,
  Service
>(serviceFrontmatterSchema)
export const validateProcedure = makeFrontmatterValidator<
  typeof procedureFrontmatterSchema._zod.output,
  Procedure
>(procedureFrontmatterSchema)
export const validatePricingModel = makeFrontmatterValidator<
  typeof pricingModelFrontmatterSchema._zod.output,
  PricingModel
>(pricingModelFrontmatterSchema)
export const validateCounterparty = makeFrontmatterValidator<
  typeof counterpartyFrontmatterSchema._zod.output,
  Counterparty
>(counterpartyFrontmatterSchema)
export const validateEngagement = makeFrontmatterValidator<
  typeof engagementFrontmatterSchema._zod.output,
  Engagement
>(engagementFrontmatterSchema)
export const validateAgreement = makeFrontmatterValidator<
  typeof agreementFrontmatterSchema._zod.output,
  Agreement
>(agreementFrontmatterSchema)
export const validateDeliverable = makeFrontmatterValidator<
  typeof deliverableFrontmatterSchema._zod.output,
  Deliverable
>(deliverableFrontmatterSchema)
export const validateInvoice = makeFrontmatterValidator<
  typeof invoiceFrontmatterSchema._zod.output,
  Invoice
>(invoiceFrontmatterSchema)
export const validateRoutine = makeFrontmatterValidator<
  typeof routineFrontmatterSchema._zod.output,
  Routine
>(routineFrontmatterSchema)
export const validateCapacity = makeFrontmatterValidator<
  typeof capacityFrontmatterSchema._zod.output,
  Capacity
>(capacityFrontmatterSchema)

// ─── Cross-doctype consistency ────────────────────────────────────────

export interface AgenciesWorkspaceFiles {
  agency?: Agency
  operations?: Operations
  services?: Map<string, Service>
  procedures?: Map<string, Procedure>
  pricingModels?: Map<string, PricingModel>
  counterparties?: Map<string, Counterparty>
  engagements?: Map<string, Engagement>
  agreements?: Map<string, Agreement>
  deliverables?: Map<string, Deliverable>
  invoices?: Map<string, Invoice>
  routines?: Map<string, Routine>
  capacities?: Map<string, Capacity>
}

/**
 * Walk a parsed workspace and check cross-doctype consistency:
 *   - SERVICE.defaultProcedure refs an existing PROCEDURE.md
 *   - SERVICE.defaultPricingModel refs an existing PRICING-MODEL.md
 *   - ENGAGEMENT.serviceSlug refs an existing SERVICE.md
 *   - ENGAGEMENT.activeProcedure refs an existing PROCEDURE.md
 *   - ENGAGEMENT.primaryCounterpartyId refs an existing COUNTERPARTY.md
 *   - AGREEMENT.primaryCounterpartyId refs an existing COUNTERPARTY.md
 *   - INVOICE.engagementSlug + INVOICE.counterpartyId ref existing entries
 *   - ROUTINE.runs refs an existing PROCEDURE.md
 *
 * Returns a list of ValidationError; empty list = consistent.
 */
export function checkAgenciesConsistency(
  ws: AgenciesWorkspaceFiles
): ValidationError[] {
  const errors: ValidationError[] = []
  const has = <K, V>(m: Map<K, V> | undefined, key: K): boolean =>
    !!m && m.has(key)

  for (const [slug, svc] of ws.services ?? new Map()) {
    const fm = svc.frontmatter
    if (fm.defaultProcedure && !has(ws.procedures, fm.defaultProcedure)) {
      errors.push({
        path: ["services", slug, "frontmatter", "defaultProcedure"],
        message: `SERVICE.defaultProcedure '${fm.defaultProcedure}' has no matching PROCEDURE.md`,
        code: "dangling_ref",
      })
    }
    if (
      fm.defaultPricingModel &&
      !has(ws.pricingModels, fm.defaultPricingModel)
    ) {
      errors.push({
        path: ["services", slug, "frontmatter", "defaultPricingModel"],
        message: `SERVICE.defaultPricingModel '${fm.defaultPricingModel}' has no matching PRICING-MODEL.md`,
        code: "dangling_ref",
      })
    }
  }

  for (const [slug, eng] of ws.engagements ?? new Map()) {
    const fm = eng.frontmatter
    if (fm.serviceSlug && !has(ws.services, fm.serviceSlug)) {
      errors.push({
        path: ["engagements", slug, "frontmatter", "serviceSlug"],
        message: `ENGAGEMENT.serviceSlug '${fm.serviceSlug}' has no matching SERVICE.md`,
        code: "dangling_ref",
      })
    }
    if (fm.activeProcedure && !has(ws.procedures, fm.activeProcedure)) {
      errors.push({
        path: ["engagements", slug, "frontmatter", "activeProcedure"],
        message: `ENGAGEMENT.activeProcedure '${fm.activeProcedure}' has no matching PROCEDURE.md`,
        code: "dangling_ref",
      })
    }
    if (!has(ws.counterparties, fm.primaryCounterpartyId)) {
      errors.push({
        path: ["engagements", slug, "frontmatter", "primaryCounterpartyId"],
        message: `ENGAGEMENT.primaryCounterpartyId '${fm.primaryCounterpartyId}' has no matching COUNTERPARTY.md`,
        code: "dangling_ref",
      })
    }
  }

  for (const [slug, agr] of ws.agreements ?? new Map()) {
    const fm = agr.frontmatter
    if (!has(ws.counterparties, fm.primaryCounterpartyId)) {
      errors.push({
        path: ["agreements", slug, "frontmatter", "primaryCounterpartyId"],
        message: `AGREEMENT.primaryCounterpartyId '${fm.primaryCounterpartyId}' has no matching COUNTERPARTY.md`,
        code: "dangling_ref",
      })
    }
  }

  for (const [slug, inv] of ws.invoices ?? new Map()) {
    const fm = inv.frontmatter
    if (!has(ws.counterparties, fm.counterpartyId)) {
      errors.push({
        path: ["invoices", slug, "frontmatter", "counterpartyId"],
        message: `INVOICE.counterpartyId '${fm.counterpartyId}' has no matching COUNTERPARTY.md`,
        code: "dangling_ref",
      })
    }
    if (fm.engagementSlug && !has(ws.engagements, fm.engagementSlug)) {
      errors.push({
        path: ["invoices", slug, "frontmatter", "engagementSlug"],
        message: `INVOICE.engagementSlug '${fm.engagementSlug}' has no matching ENGAGEMENT.md`,
        code: "dangling_ref",
      })
    }
  }

  for (const [slug, r] of ws.routines ?? new Map()) {
    if (!has(ws.procedures, r.frontmatter.runs)) {
      errors.push({
        path: ["routines", slug, "frontmatter", "runs"],
        message: `ROUTINE.runs '${r.frontmatter.runs}' has no matching PROCEDURE.md`,
        code: "dangling_ref",
      })
    }
  }

  return errors
}
