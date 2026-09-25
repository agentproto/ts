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

export const ONBOARDING_STEPS: readonly OnboardingStep[] = [
  preflightStep,
  workspaceStep,
  daemonStep,
  agentsStep,
  authStep,
  clientsStep,
  skillsStep,
]
