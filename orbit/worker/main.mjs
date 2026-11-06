// Worker: reads .orbit/ of every repo Orca knows, tracks live agents from events, serves the panel.
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, watch } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildBoard } from '../lib/board.mjs'
import { agentsInRepo, resolveFocus } from '../lib/focus.mjs'
import { planPause, taskEditedMessage } from '../lib/pause.mjs'
import { appendReminder, decideTool, isGuardedTool, workspacePathOf } from '../lib/guard.mjs'
import { editTask, findPrimaryRoot, listTasks, readTask, stateRoot, usesOrbit, worktreePaths } from '../lib/store.mjs'

const ROOTS_TTL_MS = 5_000
const INTERRUPT_GAP_MS = 300 // let the agent's prompt settle after the interrupt before the message is typed
const DONE_AGENT_TTL_MS = 6 * 60 * 60 * 1000
const ORBIT_COMMAND = `node ${fileURLToPath(new URL('../skills/orbit-project/scripts/orbit.mjs', import.meta.url))}`

const watchers = new Map()
let timer

export function deactivate() {
  clearTimeout(timer)
  for (const w of watchers.values()) w.close()
  watchers.clear()
}

// The plugin API cannot interrupt an agent (ESC through terminal.sendText does nothing to Claude Code),
// but `orca terminal send --interrupt` does, and it also reaches terminals outside the focused worktree.
const bundledCli = join(dirname(process.execPath), '..', 'Resources', 'bin', 'orca') // macOS app layout

function orcaTerminalSend(cli, terminalId, ...flags) {
  return new Promise((resolve, reject) => {
    execFile(cli, ['terminal', 'send', '--terminal', terminalId, ...flags, '--json'], { timeout: 8_000 }, (error, stdout) => {
      if (error) return reject(error)
      try {
        return JSON.parse(stdout.slice(stdout.indexOf('{'))).ok ? resolve() : reject(new Error('the Orca CLI refused'))
      } catch {
        return reject(new Error('unreadable Orca CLI output'))
      }
    })
  })
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

  const label = (a) => a.title ?? a.paneKey
  const liveAgents = () => [...agents.values()]
  async function repoRootOrThrow(root) {
    if (!(await repoRoots()).list.includes(root)) throw new Error('unknown repo')
    return root
  }

  orca.panels.handle('task.get', async ({ root, id }) => {
    await repoRootOrThrow(root)
    const task = readTask(root, id)
    const { pause, skipped } = planPause({ task, agents: liveAgents() })
    return {
      ...task,
      working: pause.map((a) => ({ title: label(a) })),
      notInterruptible: skipped.map((s) => ({ title: label(s.agent), reason: s.reason }))
    }
  })

  // Saves the edit, then (optionally) interrupts agents working on the task and asks them to re-check.
  orca.panels.handle('task.update', async ({ root, id, title, body, status, baseHash, pause }) => {
    await repoRootOrThrow(root)
    const { changed, hash } = editTask(root, id, { title, body, status, baseHash })
    const result = { changed, hash, paused: [], skipped: [] }
    if (!pause || !(changed.title || changed.body)) return result
    const plan = planPause({ task: readTask(root, id), agents: liveAgents() })
    const skipped = plan.skipped.map((s) => ({ title: label(s.agent), reason: s.reason }))
    const configured = await orca.settings.get('orcaCli')
    const cli = configured || (existsSync(bundledCli) ? bundledCli : 'orca')
    const message = taskEditedMessage(id, ORBIT_COMMAND)

    // Interrupt first, so the message lands in an idle prompt instead of queueing behind a running turn.
    const interruptFailure = new Map()
    for (const a of plan.pause) {
      try {
        await orcaTerminalSend(cli, a.terminalId, '--interrupt')
      } catch (error) {
        interruptFailure.set(a.terminalId, error.message)
      }
    }
    if (interruptFailure.size < plan.pause.length) await new Promise((r) => setTimeout(r, INTERRUPT_GAP_MS))

    const paused = []
    for (const a of plan.pause) {
      const whyNotInterrupted = interruptFailure.get(a.terminalId)
      try {
        if (whyNotInterrupted) {
          // No CLI: the message still goes through the plugin API (focused worktree only) and queues.
          await orca.host.call('terminal.sendText', { terminalId: a.terminalId, text: message, enter: true })
        } else {
          await orcaTerminalSend(cli, a.terminalId, '--text', message, '--enter')
        }
        if (whyNotInterrupted) skipped.push({ title: label(a), reason: `could not interrupt (${whyNotInterrupted}); the message was queued` })
        else paused.push(label(a))
      } catch (error) {
        const reasons = [whyNotInterrupted && `could not interrupt (${whyNotInterrupted})`, `could not reach its terminal (${error.message})`]
        skipped.push({ title: label(a), reason: reasons.filter(Boolean).join('; ') })
      }
    }
    notify()
    return { ...result, paused, skipped }
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
