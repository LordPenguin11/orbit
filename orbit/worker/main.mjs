// Worker: reads .orbit/ of every repo Orca knows, tracks live agents from events, serves the panel.
import { mkdirSync, watch } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildBoard } from '../lib/board.mjs'
import { agentsInRepo, resolveFocus } from '../lib/focus.mjs'
import { appendReminder, decideTool, isGuardedTool, workspacePathOf } from '../lib/guard.mjs'
import { findPrimaryRoot, listTasks, stateRoot, usesOrbit, worktreePaths } from '../lib/store.mjs'

const ROOTS_TTL_MS = 5_000
const DONE_AGENT_TTL_MS = 6 * 60 * 60 * 1000
const ORBIT_COMMAND = `node ${fileURLToPath(new URL('../skills/orbit-project/scripts/orbit.mjs', import.meta.url))}`

const watchers = new Map()
let timer

export function deactivate() {
  clearTimeout(timer)
  for (const w of watchers.values()) w.close()
  watchers.clear()
}

/** @type {import('orca/worker').Activate} */
export default async function activate(orca) {
  const saved = await orca.host.call('storage.get', { key: 'agents' })
  const agents = new Map(Object.entries(saved?.value ?? {}))
  let roots = { at: 0, list: [], workspaces: [] }

  const notify = () => {
    clearTimeout(timer)
    timer = setTimeout(() => orca.panels.post('board.changed', {}), 200)
  }

  // Watches shared state plus every worktree's task definitions. Recomputed on each refresh so new worktrees join.
  function watchRepo(root) {
    const state = join(stateRoot(root), 'state')
    mkdirSync(state, { recursive: true })
    for (const dir of [state, ...worktreePaths(root).map((p) => join(p, '.orbit', 'tasks'))]) {
      if (watchers.has(dir)) continue
      try {
        // ponytail: fs.watch is not recursive and can drop events; the 5s refresh and panel reopen cover gaps
        watchers.set(dir, watch(dir, notify))
      } catch {
        // folder not created yet in this worktree; picked up on a later refresh
      }
    }
  }

  // ponytail: refreshes the repo list every 5s on demand; subscribe to workspace events if it matters
  async function repoRoots() {
    if (Date.now() - roots.at < ROOTS_TTL_MS) return roots
    const { workspaces } = await orca.host.call('workspace.list', {})
    const found = new Set()
    for (const w of workspaces) {
      if (w.kind !== 'worktree') continue
      try {
        const root = findPrimaryRoot(w.path)
        if (usesOrbit(root)) found.add(root)
      } catch {
        // remote or deleted worktree: not readable from this machine
      }
    }
    for (const root of found) watchRepo(root)
    roots = { at: Date.now(), list: [...found], workspaces }
    return roots
  }

  orca.events.on('agent.status.changed', async (e) => {
    agents.set(e.paneKey, {
      paneKey: e.paneKey,
      workspaceId: e.workspaceId,
      terminalId: e.terminalId ?? null,
      title: e.title ?? null,
      state: e.state,
      receivedAt: e.receivedAt
    })
    for (const [key, a] of agents) {
      if (a.state === 'done' && Date.now() - a.receivedAt > DONE_AGENT_TTL_MS) agents.delete(key)
    }
    await orca.host.call('storage.set', { key: 'agents', value: Object.fromEntries(agents) })
    notify()
  })

  // Hooks decide in-process first: Orca gives each 2s and passes the action through on timeout.
  orca.hooks.on('agent.tool.before', async (e) => {
    if (!isGuardedTool(e.tool) || !e.workspaceId) return
    const mode = await orca.settings.get('guardMode')
    if (mode !== 'block') return
    // The event id carries the path; workspace.list ids use another scheme, so it is only a fallback.
    const workspacePath =
      workspacePathOf(e.workspaceId) ??
      (await repoRoots()).workspaces.find((w) => w.id === e.workspaceId)?.path
    if (!workspacePath) return
    let tasks = []
    try {
      tasks = listTasks(workspacePath)
    } catch {
      return // not a git checkout readable here
    }
    return decideTool({
      mode,
      tool: e.tool,
      input: e.input,
      workspaceId: e.workspaceId,
      workspacePath,
      tasks,
      orbitCommand: ORBIT_COMMAND
    }) ?? undefined
  })

  orca.hooks.on('agent.prompt.before', async (e, next) => {
    if (e.inputKind === 'driving' || (await orca.settings.get('guardMode')) === 'off') return
    if ((await repoRoots()).list.length === 0) return // no repo uses Orbit
    return next({ ...e, prompt: appendReminder(e.prompt) })
  })

  const safeUsesOrbit = (path) => {
    try {
      return usesOrbit(path)
    } catch {
      return false // not a git checkout readable here
    }
  }

  // The panel follows the focused project: only its repo and the agents running inside it.
  orca.panels.handle('board.get', async () => {
    const live = [...agents.values()].sort((a, b) => b.receivedAt - a.receivedAt)
    const { workspaces } = await repoRoots()
    const focus = resolveFocus(await orca.host.call('workspace.readContext', {}), workspaces, {
      usesOrbit: safeUsesOrbit,
      terminalWorkspace: new Map(live.filter((a) => a.terminalId).map((a) => [a.terminalId, a.workspaceId]))
    })
    const paths = focus.path ? [focus.path] : (focus.ambiguous ?? [])
    const shownRoots = [...new Set(paths.map(findPrimaryRoot))]
    const shown = agentsInRepo(live, shownRoots.flatMap(worktreePaths))
    const repos = []
    const taskOf = new Map()
    for (const root of shownRoots) {
      const board = buildBoard(listTasks(root), shown)
      for (const a of board.agents) if (a.taskId) taskOf.set(a.paneKey, { taskId: a.taskId, repo: basename(root) })
      repos.push({ root, name: basename(root), columns: board.columns, progress: board.progress })
    }
    return {
      focus: focus.path ? 'project' : focus.ambiguous ? 'ambiguous' : focus.none ? 'none' : 'noFocus',
      repos,
      agents: shown.map((a) => ({ ...a, ...taskOf.get(a.paneKey) })),
      agentCounts: buildBoard([], shown).agentCounts
    }
  })
}
