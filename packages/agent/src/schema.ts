/**
 * AIP-42 AGENT.md frontmatter zod schema.
 *
 * Generated from `resources/aip-42/draft/AGENT.schema.json` via
 * json-schema-to-zod. Imported by both `define-agent.ts` (TS path
 * validation) and `manifest/index.ts` (.md path validation) so every
 * field-level constraint runs in both authoring paths from a single
 * source of truth — re-run scaffold-aip to refresh after spec changes.
 *
 * Cross-field rules (if/then/allOf in JSON Schema) don't translate
 * cleanly and live in `define-agent.ts`'s `validate(def)` instead.
 */

import { z } from "zod"

export const agentFrontmatterSchema = z.object({ "schema": z.literal("agent/v1"), "id": z.string().regex(new RegExp("^[a-z0-9@][a-z0-9.@/_-]*$")).min(2).max(80).describe("Machine identifier. Optional @<owner>/ prefix. Unique within the registry that hosts the agent."), "description": z.string().min(1).max(2000).describe("One-paragraph purpose."), "version": z.string().regex(new RegExp("^\\d+\\.\\d+\\.\\d+(?:[-+][\\w.\\-]+)?$")).describe("Spec version of THIS file.").default("1.0.0"), "extends": z.any().describe("Parent AGENT this extends. Inherits all fields; child overrides win.").optional(), "model": z.any().describe("The brain — provider/model id string or structured ref."), "identity": z.any().describe("AIP-23 identity ref. Defaults to host policy.").optional(), "persona": z.any().describe("AIP-25 persona ref.").optional(), "runner": z.any().describe("AIP-17 runtime engine ref.").optional(), "tools": z.array(z.any()).describe("AIP-14 tool refs.").default([] as never), "actions": z.object({ "granted": z.array(z.any()).default([] as never) }).strict().describe("Explicit action allow-list. POLICY checks union of this + tools' implements.").optional(), "skills": z.array(z.any()).describe("AIP-3 skill refs.").default([] as never), "workflows": z.array(z.any()).describe("AIP-15 workflow refs.").default([] as never), "routines": z.array(z.any()).describe("AIP-41 routine refs that auto-fire this agent.").default([] as never), "delegates_to": z.array(z.any()).describe("Sub-agents this agent may dispatch to (council pattern, AIP-24).").default([] as never), "memory": z.any().describe("Memory configuration.").optional(), "governance": z.any().describe("AIP-7 governance binding.").optional(), "policy": z.any().describe("AIP-38 POLICY binding.").optional(), "traits": z.record(z.string(), z.number().gte(0).lte(10)).describe("Free-form numeric trait scores (0-10).").default({} as never), "autonomy": z.number().int().gte(0).lte(10).describe("How much the agent acts vs asks. 0 = always asks, 10 = full autonomy.").default(5), "boundaries": z.array(z.string().min(1)).describe("Hard rules the agent MUST decline / escalate. Surfaced into system prompt.").default([] as never), "on": z.record(z.string(), z.any().superRefine((x, ctx) => {
    const schemas = [z.any(), z.array(z.any())];
    const { errors, failed } = schemas.reduce<{
      errors: z.core.$ZodIssue[];
      failed: number;
    }>(
      ({ errors, failed }, schema) =>
        ((result) =>
          result.error
            ? {
                errors: [...errors, ...result.error.issues],
                failed: failed + 1,
              }
            : { errors, failed })(
          schema.safeParse(x),
        ),
      { errors: [], failed: 0 },
    );
    const passed = schemas.length - failed;
    if (passed !== 1) {
      ctx.addIssue(errors.length ? {
        path: [],
        code: "invalid_union",
        errors: [errors],
        message: "Invalid input: Should pass single schema. Passed " + passed,
      } : {
        path: [],
        code: "custom",
        errors: [errors],
        message: "Invalid input: Should pass single schema. Passed " + passed,
      });
    }
  })).describe("Lifecycle hooks. AIP-37 event name -> action-ref(s) to invoke.").default({} as never), "publish": z.object({ "visibility": z.enum(["private","unlisted","public"]).default("private"), "registry": z.string().optional() }).strict().default({"visibility":"private"}), "tags": z.array(z.string()).default([] as never), "metadata": z.record(z.string(), z.any()).optional() }).strict().describe("Validates the YAML frontmatter portion of an AIP-42 AGENT.md manifest. Composes identity, persona, model, tools, actions, skills, workflows, runner, memory, governance, policy, routines into a single runnable definition.")

export type AgentFrontmatter = z.infer<typeof agentFrontmatterSchema>
