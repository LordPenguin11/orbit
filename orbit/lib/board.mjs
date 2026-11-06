// Pure board model: tasks + live agents in, kanban columns + progress out.
import { STATUSES } from './store.mjs'

const AGENT_STATES = ['working', 'blocked', 'waiting', 'done']

export function buildBoard(tasks, agents) {
  const doneIds = new Set(tasks.filter((t) => t.status === 'done').map((t) => t.id))
  const columns = Object.fromEntries(STATUSES.map((s) => [s, []]))
  const taskOf = new Map()

  for (const task of tasks) {
    const waitingOn = (task.depends ?? []).filter((d) => !doneIds.has(d))
    const blockedByDeps = task.status === 'todo' && waitingOn.length > 0
    const agent = agents.find(
      (a) => a.paneKey === task.owner || (task.worktree && a.workspaceId === task.worktree)
    )
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
