/**
 * @agentproto/harness — WorkPackage type + supervisor prompt renderer (WP5).
 *
 * A WorkPackage describes a unit of work the supervisor assigns to a sub-agent.
 * `renderSupervisorPrompt` turns a list into a markdown orchestration brief.
 */

/** A unit of work the supervisor harness assigns to a sub-agent. */
export interface WorkPackage {
  id: string          // e.g. "WP1"
  title: string
  description: string
  files?: string[]    // file scope
  gate?: string       // gate command
}

/** Renders a WP list into a supervisor orchestration brief. */
export function renderSupervisorPrompt(workPackages: WorkPackage[]): string {
  const header =
    "You are a supervisor agent. Execute the following work packages in order, " +
    "assigning each to a sub-agent. Gate each WP before proceeding to the next."

  const body = workPackages
    .map(wp => {
      let s = `## ${wp.id} — ${wp.title}\n${wp.description}`
      if (wp.files?.length) s += `\nFiles: ${wp.files.join(", ")}`
      if (wp.gate) s += `\nGate: ${wp.gate}`
      return s
    })
    .join("\n\n")

  return `${header}\n\n${body}`
}