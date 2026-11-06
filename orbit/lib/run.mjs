// The prompt the Run button hands to a fresh agent. Pure. The assignee is only a request in the prompt:
// Orbit cannot force which agent or skill the session uses.
export function runPrompt({ id, orbitCommand, assignee }) {
  const lines = [
    `Use the orbit-project skill for ${id}. Read it with \`${orbitCommand} brief ${id}\`, claim it with ` +
      `\`${orbitCommand} claim ${id}\`, do only that task, then set it to review with \`${orbitCommand} status ${id} review\`.`
  ]
  const [kind, ...rest] = (assignee ?? '').split(':')
  const name = rest.join(':')
  if (kind === 'agent' && name) lines.push(`Do the work with the ${name} agent: delegate it through the Agent tool with subagent_type "${name}".`)
  if (kind === 'skill' && name) lines.push(`Use the ${name} skill for this task.`)
  return lines.join(' ')
}
