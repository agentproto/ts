/** The ordered onboarding steps — shared by `agentproto doctor` and, later,
 *  `agentproto setup`. Order is the "first win" path. */

import type { OnboardingStep } from "./types.js"
import { preflightStep } from "./steps/preflight.js"
import { workspaceStep } from "./steps/workspace.js"
import { daemonStep } from "./steps/daemon.js"
import { agentsStep } from "./steps/agents.js"
import { authStep } from "./steps/auth.js"
import { clientsStep } from "./steps/clients.js"
import { skillsStep } from "./steps/skills.js"
import { firstRunStep } from "./steps/first-run.js"
import { localModelStep } from "./steps/local-model.js"

export const ONBOARDING_STEPS: readonly OnboardingStep[] = [
  preflightStep,
  workspaceStep,
  daemonStep,
  agentsStep,
  authStep,
  clientsStep,
  skillsStep,
  localModelsStep,
]

/** `agentproto setup`'s steps: the doctor checklist, then the proof-it-works
 *  first run, then extras (default off). */
export const SETUP_STEPS: readonly OnboardingStep[] = [...ONBOARDING_STEPS, firstRunStep, localModelStep]
