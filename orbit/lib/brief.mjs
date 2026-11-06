// The smallest context an agent needs to start a task: read this instead of scanning .orbit/.
// Pure formatting; store.readBrief gathers the inputs.
const firstGoalLine = (body = '') => {
  const goal = /##\s*(?:Goal|Do)\s*\n+([^\n#][^\n]*)/.exec(body)
  return goal ? goal[1].trim() : ''
}

export function formatBrief({ task, feature, parent, dependencies, subtasks, size }) {
  const lines = [`${task.id} ${task.kind} [${task.status}] ${task.title}`]
  if (feature) lines.push(`Feature ${feature.id} ${feature.title}: ${firstGoalLine(feature.body)}`.trimEnd())
  if (parent) lines.push(`Parent ${parent.id} ${parent.title}: ${firstGoalLine(parent.body)}`.trimEnd())
  if (task.assignee) lines.push(`Assignee: ${task.assignee}`)
  if (size) lines.push(`Size: ${size}`)
  if (dependencies.length > 0) lines.push(`Depends: ${dependencies.map((d) => `${d.id} (${d.status})`).join(', ')}`)
  if (subtasks.length > 0) {
    lines.push('Subtasks:', ...subtasks.map((s) => `- ${s.id} [${s.status}] ${s.title}`))
  }
  return `${lines.join('\n')}\n\n${task.body.trim()}\n`
}
