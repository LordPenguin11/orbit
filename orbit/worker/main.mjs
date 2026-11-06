// Worker: reads .orbit/ of every repo Orca knows, tracks live agents from events, serves the panel.
import { existsSync, watch } from 'node:fs'
import { basename, join } from 'node:path'
import { buildBoard } from '../lib/board.mjs'
import { findPrimaryRoot, listTasks } from '../lib/store.mjs'

const ROOTS_TTL_MS = 5_000
const DONE_AGENT_TTL_MS = 6 * 60 * 60 * 1000

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
  let roots = { at: 0, list: [] }

  const notify = () => {
    clearTimeout(timer)
    timer = setTimeout(() => orca.panels.post('board.changed', {}), 200)
  }

  // ponytail: refreshes the repo list every 5s on demand; subscribe to workspace events if it matters
  async function repoRoots() {
    if (Date.now() - roots.at < ROOTS_TTL_MS) return roots.list
    const { workspaces } = await orca.host.call('workspace.list', {})
    const found = new Set()
    for (const w of workspaces) {
      if (w.kind !== 'worktree') continue
      try {
        const root = findPrimaryRoot(w.path)
        if (existsSync(join(root, '.orbit', 'tasks'))) found.add(root)
      } catch {
        // remote or deleted worktree: not readable from this machine
      }
    }
    for (const root of found) {
      if (watchers.has(root)) continue
      // ponytail: fs.watch is not recursive and can drop events; the 5s refresh and panel reopen cover gaps
      watchers.set(root, watch(join(root, '.orbit', 'tasks'), notify))
    }
    roots = { at: Date.now(), list: [...found] }
    return roots.list
  }

  orca.events.on('agent.status.changed', async (e) => {
    agents.set(e.paneKey, {
      paneKey: e.paneKey,
      workspaceId: e.workspaceId,
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

  orca.panels.handle('board.get', async () => {
    const live = [...agents.values()].sort((a, b) => b.receivedAt - a.receivedAt)
    const repos = []
    const taskOf = new Map()
    for (const root of await repoRoots()) {
      const board = buildBoard(listTasks(root), live)
      for (const a of board.agents) if (a.taskId) taskOf.set(a.paneKey, { taskId: a.taskId, repo: basename(root) })
      repos.push({ root, name: basename(root), columns: board.columns, progress: board.progress })
    }
    return {
      repos,
      agents: live.map((a) => ({ ...a, ...taskOf.get(a.paneKey) })),
      agentCounts: buildBoard([], live).agentCounts
    }
  })
}
