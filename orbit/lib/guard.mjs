// Pure guard decisions for the agent hooks: no host calls, so they are cheap to test and fast (hooks get 2s).
const MUTATING_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const WORKING = new Set(['doing', 'review'])
const MARKER = 'orbit-project'

const REMINDER = `[Orbit] This repo tracks work in .orbit/. Use the ${MARKER} skill: claim a task (\`task claim <id>\`) before changing files, then set it to review or done when finished.`

/** Orca's workspace ids in hook events look like `<uuid>::<absolute path>`; other id shapes return null. */
export const workspacePathOf = (id) => (id && id.includes('::') ? id.slice(id.indexOf('::') + 2) : null)

export const isGuardedTool = (tool) => MUTATING_TOOLS.has(tool)

export function appendReminder(prompt) {
  return prompt.includes(MARKER) ? prompt : `${prompt}\n\n${REMINDER}`
}

const pathOf = (input) => input?.file_path ?? input?.notebook_path ?? input?.path ?? ''

/**
 * @returns {{ deny: string } | null} null lets the call through.
 * Fails open on anything unknown: no Orbit tasks in the repo, no workspace, off mode, other tools.
 */
export function decideTool({ mode, tool, input, workspaceId, workspacePath, tasks, orbitCommand }) {
  if (mode !== 'block' || !MUTATING_TOOLS.has(tool) || !workspaceId || tasks.length === 0) return null
  if (String(pathOf(input)).includes('/.orbit/')) return null
  const claimed = tasks.some(
    (t) =>
      WORKING.has(t.status) &&
      ((t.worktree && t.worktree === workspaceId) || (t.workspace && t.workspace === workspacePath))
  )
  if (claimed) return null
  return {
    deny:
      `Orbit guard: no task is claimed in this workspace. Run \`${orbitCommand ?? 'orbit'} task list --status todo\` ` +
      `then \`${orbitCommand ?? 'orbit'} task claim <id>\` before editing files. ` +
      'If the work has no task, create one with `task new`, or ask the user to turn the Orbit guard off.'
  }
}
