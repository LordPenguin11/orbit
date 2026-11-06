// Which project is the person looking at? Pure: the worker feeds it host data.
// readContext gives only displayName + branch + terminal ids, and many workspaces share "main"/"main",
// so name alone is not an identity. Prefer a terminal id seen in an agent event (exact), then fall back to
// name+branch narrowed to repos that actually use Orbit.
import { workspacePathOf } from './guard.mjs'

/**
 * @returns {{ path: string } | { none: true } | { ambiguous: string[] } | { noFocus: true }}
 */
export function resolveFocus(context, workspaces, { usesOrbit, terminalWorkspace = new Map() }) {
  if (!context) return { noFocus: true }
  const resolved = (path) => (usesOrbit(path) ? { path } : { none: true })
  for (const t of context.terminals ?? []) {
    const path = workspacePathOf(terminalWorkspace.get(t.id))
    if (path) return resolved(path)
  }
  const candidates = workspaces.filter((w) => w.name === context.displayName && w.branch === context.branch)
  if (candidates.length === 1) return resolved(candidates[0].path)
  const orbit = candidates.filter((w) => usesOrbit(w.path)).map((w) => w.path)
  if (orbit.length === 1) return { path: orbit[0] }
  return orbit.length === 0 ? { none: true } : { ambiguous: orbit }
}

/** Agents whose workspace (from the `<uuid>::<path>` id) is one of the repo's worktrees. */
export function agentsInRepo(agents, repoPaths) {
  return agents.filter((a) => {
    const path = workspacePathOf(a.workspaceId)
    return path && repoPaths.includes(path)
  })
}
