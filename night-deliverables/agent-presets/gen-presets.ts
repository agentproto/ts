/**
 * TACHE 16 - prototype : table (agent x prereglage) -> AGENT.md.
 *
 * Ce script ne modifie aucun package publie : il vit hors de `packages/`,
 * il lit les dist deja construites de `@agentproto/agent` (validation
 * AIP-42 via `defineAgent`) et de `@agentproto/app-kit` (rendu canonique via
 * `renderAgentManifest`, le meme chemin que `agentproto agent create`).
 *
 * Il prototype deux choses :
 *
 *  1. le **merge** "prereglage = manifeste enfant qui extends un agent de
 *     base et ne change que quelques champs" : le daemon ne sait pas
 *     fusionner les champs du parent a travers `extends` (le plan, section
 *     2.3), donc le merge est fait ici, a la generation ;
 *  2. le **bloc de prereglage** `metadata.agentproto.preset`, seul endroit du
 *     frontmatter AIP-42 ou un prereglage peut loger sans toucher au schema
 *     (`metadata` est un record libre).
 *
 * Usage :
 *
 *   node --experimental-strip-types night-deliverables/agent-presets/gen-presets.ts --out /tmp/presets
 *
 * Prerequis (les dist doivent etre construites) :
 *
 *   pnpm install --filter "@agentproto/agent..." --filter "@agentproto/app-kit..."
 *   pnpm --filter "@agentproto/agent..." --filter "@agentproto/app-kit..." build
 */

import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { defineAgent, loadAgent } from "../../packages/agent/dist/index.mjs"
import { renderAgentManifest } from "../../packages/app-kit/dist/index.mjs"

// ── Types (locaux : le script tourne sur du TS strippe, sans typage de
//    paquet importe, donc aucun `import type` depuis les dist). ──────────

interface PresetAxes {
  harness: string
  model: string
  access?: { profileRef: string }
  posture: string
  effort: string
  contextProfile: string
  keepAlive: boolean
  turnRetry?: { on: string[]; maxRetries?: number; rotate?: { model: string }[] }
  resumeNote?: string
}

interface Preset {
  id: string
  label: string
  axes: PresetAxes
}

interface BaseAgent {
  id: string
  description: string
  model: string
  tools: string[]
  autonomy: number
  boundaries: string[]
  body: string
}

// ── La table de prereglages (section 6 du plan). ────────────────────────

const PRESETS: Preset[] = [
  {
    id: "gratuit",
    label: "Gratuit (Zen ws03)",
    axes: {
      harness: "zen",
      model: "ws03",
      access: { profileRef: "gratuit" },
      posture: "default",
      effort: "low",
      contextProfile: "lean",
      keepAlive: false,
      resumeNote: "Nuit : rien ne parle a personne, on avance sans deranger.",
    },
  },
  {
    id: "go",
    label: "Go (DeveloperWs003)",
    axes: {
      harness: "opencode-go",
      model: "zhipuai/glm-5.3-flash",
      access: { profileRef: "DeveloperWs003" },
      posture: "default",
      effort: "medium",
      contextProfile: "lean",
      keepAlive: true,
      turnRetry: { on: ["rate_limit"], maxRetries: 2, rotate: [{ model: "ws03" }] },
      resumeNote: "Reprise apres swap : relire les rapports avant d agir.",
    },
  },
  {
    id: "abonnement",
    label: "Abonnement Claude (Sonnet 5.5)",
    axes: {
      harness: "claude-code",
      model: "sonnet-5.5",
      access: { profileRef: "claude-subs-agentik" },
      posture: "accept-edits",
      effort: "high",
      contextProfile: "full",
      keepAlive: true,
      turnRetry: { on: ["rate_limit"], maxRetries: 1 },
      resumeNote: "Reprise apres swap : relire les rapports avant d agir.",
    },
  },
  {
    id: "economie",
    label: "Economie (autocompact bas, reveils reduits)",
    axes: {
      harness: "opencode-go",
      model: "zhipuai/glm-5.3-flash",
      access: { profileRef: "DeveloperWs003" },
      posture: "read-only",
      effort: "low",
      contextProfile: "lean",
      keepAlive: true,
      turnRetry: { on: ["rate_limit"], maxRetries: 1 },
      resumeNote: "Reprise apres swap : relecture seule, on ne modifie rien.",
    },
  },
  {
    id: "nuit",
    label: "Nuit (02h-07h)",
    axes: {
      harness: "opencode-go",
      model: "ws03",
      access: { profileRef: "gratuit" },
      posture: "default",
      effort: "low",
      contextProfile: "lean",
      keepAlive: false,
      resumeNote: "Nuit : reveils rares, on n emporte que le strict necessaire.",
    },
  },
  {
    id: "jour",
    label: "Jour (journee normale)",
    axes: {
      harness: "opencode-go",
      model: "zhipuai/glm-5.3-flash",
      access: { profileRef: "DeveloperWs003" },
      posture: "default",
      effort: "medium",
      contextProfile: "full",
      keepAlive: true,
      turnRetry: { on: ["rate_limit"], maxRetries: 2, rotate: [{ model: "ws03" }] },
      resumeNote: "Journee normale : on rappe le contexte avant de repartir.",
    },
  },
]

// ── Les agents de base. ────────────────────────────────────────────────

const BASE_AGENTS: BaseAgent[] = [
  {
    id: "pygmalion-agent-superviseur",
    description: "Superviseur permanent de l atelier Pygmalion.",
    model: "zhipuai/glm-5.3-flash",
    tools: ["session_prompt", "session_follow", "cron_create", "policy_attach"],
    autonomy: 6,
    boundaries: ["Ne jamais relire les rapports sans le dire.", "Ne pas changer de wallet sans validation operateur."],
    body: "Tu supervises les agents permanents de l atelier. Tu rappe les rapports, tu rediges les rapports, tu ne fais pas le travail a leur place.",
  },
  {
    id: "pygmalion-agent-pm",
    description: "PM permanent de l atelier Pygmalion.",
    model: "zhipuai/glm-5.3-flash",
    tools: ["session_prompt", "session_follow", "cron_create"],
    autonomy: 5,
    boundaries: ["Ne pas engager de depense sans valider le budget."],
    body: "Tu es le PM de l atelier. Tu scopes, tu dispatches, tu relis les rapports.",
  },
  {
    id: "pygmalion-agent-concepteur",
    description: "Concepteur redacteur permanent de l atelier Pygmalion.",
    model: "zhipuai/glm-5.3-flash",
    tools: ["session_prompt", "session_follow"],
    autonomy: 4,
    boundaries: ["Ne pas ecrire de rapport sans avoir lu les precedents."],
    body: "Tu concois et tu rediges. Tu t appuies sur les rapports des autres.",
  },
]

// ── Le merge : agent de base + prereglage -> manifeste enfant. ─────────
//
// Semantique : l'enfant gagne sur le parent, champ par champ. Le `extends`
// est pose pour la trace (le daemon ne fusionne pas encore, cf. plan
// section 2.3) et le bloc `metadata.agentproto.preset` porte les axes que le
// frontmatter AIP-42 ne sait pas exprimer (harnais, wallet, posture,
// contextProfile, turnRetry, keepAlive, prompt de reprise).

function mergePreset(base: BaseAgent, preset: Preset): Record<string, unknown> {
  const axes = preset.axes
  return {
    schema: "agent/v1",
    id: `${base.id}-${preset.id}`,
    description: `${base.description} Prereglage ${preset.label}.`,
    version: "1.0.0",
    extends: base.id,
    model: axes.model,
    tools: base.tools,
    autonomy: base.autonomy,
    boundaries: base.boundaries,
    metadata: {
      agentproto: {
        preset: {
          name: preset.id,
          label: preset.label,
          harness: axes.harness,
          model: axes.model,
          ...(axes.access ? { access: axes.access } : {}),
          posture: axes.posture,
          effort: axes.effort,
          contextProfile: axes.contextProfile,
          keepAlive: axes.keepAlive,
          ...(axes.turnRetry ? { turnRetry: axes.turnRetry } : {}),
          ...(axes.resumeNote ? { resumeNote: axes.resumeNote } : {}),
        },
      },
    },
  }
}

// ── Ecriture. ──────────────────────────────────────────────────────────

async function writeManifest(outDir: string, definition: Record<string, unknown>, body: string): Promise<string> {
  const handle = defineAgent(definition as never)
  const rendered = renderAgentManifest(handle as never, body, { dir: outDir, layout: "canonical" })
  await mkdir(dirname(rendered.path), { recursive: true })
  await writeFile(rendered.path, rendered.contents, "utf8")
  return rendered.path
}

async function main(): Promise<number> {
  const args = process.argv.slice(2)
  let outDir = resolve(process.cwd(), ".agents-out")
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === "--out" || arg === "-o") {
      const value = args[i + 1]
      if (!value) {
        process.stderr.write("--out demande un repertoire.\n")
        return 2
      }
      outDir = resolve(value)
      i += 1
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "gen-presets.ts --out <repertoire>\n" +
          "  Genere les manifestes AGENT.md (agent x prereglage) dans <repertoire>/.agents/.\n",
      )
      return 0
    } else {
      process.stderr.write(`Argument inconnu : ${arg}\n`)
      return 2
    }
  }

  const rows: string[] = []
  const written: string[] = []
  for (const base of BASE_AGENTS) {
    // L'agent de base d'abord : les variantes l'ont dans leur `extends`, la
    // chaine doit donc resoudre (loadAgent tolere un parent manquant, mais un
    // arbre complet est plus utile).
    const baseDefinition = {
      schema: "agent/v1",
      id: base.id,
      description: base.description,
      version: "1.0.0",
      model: base.model,
      tools: base.tools,
      autonomy: base.autonomy,
      boundaries: base.boundaries,
    }
    written.push(await writeManifest(outDir, baseDefinition, base.body))
    for (const preset of PRESETS) {
      const definition = mergePreset(base, preset)
      const path = await writeManifest(outDir, definition, base.body)
      rows.push(
        `${definition.id.padEnd(40)}  ${preset.axes.harness.padEnd(14)}  ` +
          `${String(preset.axes.model).padEnd(24)}  ${preset.axes.access?.profileRef ?? "-"}`,
      )
      rows.push(`  -> ${path}`)
      written.push(path)
    }
  }

  // Verification de bout en bout : le manifeste ecrit se relit par le
  // chargeur AIP-42 (frontmatter + chaine `extends`).
  const reloaded = await loadAgent(written[written.length - 1]!, { workspace: outDir })
  const presetName =
    (reloaded.handle.metadata as Record<string, any> | undefined)?.agentproto?.preset?.name ?? "?"

  process.stdout.write(rows.join("\n") + "\n")
  process.stdout.write(`\n${written.length} manifestes ecrits dans ${outDir}/.agents/\n`)
  process.stdout.write(
    `relecture OK : ${reloaded.handle.id} (prereglage "${presetName}", ` +
      `extends "${String(reloaded.handle.extends)}")\n`,
  )
  return 0
}

main().then(
  code => {
    process.exitCode = code
  },
  error => {
    process.stderr.write(`gen-presets.ts : ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  },
)
