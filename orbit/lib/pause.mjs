// Who to interrupt when a task is edited, and what to tell them. Pure: the worker does the typing.
import { agentsForTask } from './board.mjs'

export const taskEditedMessage = (id, orbitCommand) =>
  `Task ${id} was edited by the user. Run \`${orbitCommand} task diff ${id}\` to see the old and new ` +
  'definition, compare it with what you already did, say what changes, then continue.'

/**
 * Only agents that are `working` get typed into. A `waiting` or `blocked` agent may be showing a
 * permission prompt, where typed text plus Enter could approve something, so it is skipped with a reason.
 */
export function planPause({ task, agents }) {
  const result = { pause: [], skipped: [] }
  if (task.status !== 'doing') return result
  const seen = new Set()
  for (const agent of agentsForTask(task, agents)) {
    if (seen.has(agent.terminalId ?? agent.paneKey)) continue
    seen.add(agent.terminalId ?? agent.paneKey)
    if (!agent.terminalId) result.skipped.push({ agent, reason: 'no terminal known for this agent' })
    else if (agent.state !== 'working') result.skipped.push({ agent, reason: `agent is ${agent.state}, not interrupted` })
    else result.pause.push(agent)
  }
  return result
}
