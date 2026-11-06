// Pure board model: tasks + live agents in, kanban columns + progress out.
import { STATUSES } from './store.mjs'

const AGENT_STATES = ['working', 'blocked', 'waiting', 'done']

/**
 * Agents working on a task. The owner's pane key is authoritative. Only when no known agent has it
 * (a custom --owner name) fall back to the workspace, and only if exactly one agent is there: with
 * several, guessing would attribute the task to (or interrupt) the wrong one.
 */
export function agentsForTask(task, agents) {
  const owned = agents.filter((a) => a.paneKey === task.owner)
  if (owned.length > 0) return owned
  const here = task.worktree ? agents.filter((a) => a.workspaceId === task.worktree) : []
  return here.length === 1 ? here : []
}

export function buildBoard(tasks, agents) {
  const doneIds = new Set(tasks.filter((t) => t.status === 'done').map((t) => t.id))
  const columns = Object.fromEntries(STATUSES.map((s) => [s, []]))
  const taskOf = new Map()

  for (const task of tasks) {
    const waitingOn = (task.depends ?? []).filter((d) => !doneIds.has(d))
    const blockedByDeps = task.status === 'todo' && waitingOn.length > 0
    const [agent] = agentsForTask(task, agents)
    if (agent && task.status === 'doing') taskOf.set(agent.paneKey, task.id)
    const column = blockedByDeps ? 'blocked' : (STATUSES.includes(task.status) ? task.status : 'todo')
    columns[column].push({
      ...task,
      status: column,
      ...(blockedByDeps ? { waitingOn } : {}),
      ...(agent && task.status === 'doing' ? { agent } : {})
    })
  }

  const done = columns.done.length
  const agentCounts = { total: agents.length, ...Object.fromEntries(AGENT_STATES.map((s) => [s, 0])) }
  for (const a of agents) if (a.state in agentCounts) agentCounts[a.state]++

  return {
    columns,
    progress: { done, total: tasks.length, pct: tasks.length ? Math.round((done / tasks.length) * 100) : 0 },
    agents: agents.map((a) => ({ ...a, taskId: taskOf.get(a.paneKey) })),
    agentCounts
  }
}
