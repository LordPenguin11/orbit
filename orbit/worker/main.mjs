// Worker: reads .orbit/ of every repo Orca knows, tracks live agents from events, serves the panel.
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, watch } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildBoard } from '../lib/board.mjs'
import { rollupFeature } from '../lib/features.mjs'
import { assess } from '../lib/sizing.mjs'
import { agentsInRepo, resolveFocus } from '../lib/focus.mjs'
import { planPause, taskEditedMessage } from '../lib/pause.mjs'
import { runPrompt } from '../lib/run.mjs'
import { appendReminder, decideTool, isGuardedTool, workspacePathOf } from '../lib/guard.mjs'
import {
  archiveDone,
  archiveItem,
  archivedIds,
  catalogFor,
  editTask,
  findPrimaryRoot,
  listArchived,
  listFeatures,
  listWork,
  profileFor,
  readConfig,
  readFeature,
  readTask,
  stateRoot,
  usesOrbit,
  worktreePaths
} from '../lib/store.mjs'

const ROOTS_TTL_MS = 5_000
const INTERRUPT_GAP_MS = 300 // let the agent's prompt settle after the interrupt before the message is typed
const DONE_AGENT_TTL_MS = 6 * 60 * 60 * 1000
const ORBIT_COMMAND = `node ${fileURLToPath(new URL('../skills/orbit-project/scripts/orbit.mjs', import.meta.url))}`

const watchers = new Map()
let timer

export function deactivate() {
  clearTimeout(timer)
  for (const w of watchers.values()) {
    w.close()
  }
  watchers.clear()
}

// The plugin API cannot interrupt an agent (ESC through terminal.sendText does nothing to Claude Code),
// but `orca terminal send --interrupt` does, and it also reaches terminals outside the focused worktree.
const bundledCli = join(dirname(process.execPath), '..', 'Resources', 'bin', 'orca') // macOS app layout

function orcaRun(cli, args) {
  return new Promise((resolve, reject) => {
    execFile(cli, [...args, '--json'], { timeout: 15_000 }, (error, stdout, stderr) => {
      let out
      try {
        out = JSON.parse(stdout.slice(stdout.indexOf('{')))
      } catch {
        // no JSON body: fall through to stderr or the exec error
      }
      if (out?.ok) {
        return resolve(out)
      }
      const lastStderrLine = stderr.trim().split('\n').at(-1)
      // error.message would carry the whole command line, prompt included, so name the failure instead.
      const fallback = error
        ? error.killed
          ? 'the Orca CLI timed out'
          : `the Orca CLI exited with ${error.code}`
        : 'unreadable Orca CLI output'
      return reject(new Error(out?.error?.message ?? (lastStderrLine || fallback)))
    })
  })
}
const orcaTerminalSend = (cli, terminalId, ...flags) =>
  orcaRun(cli, ['terminal', 'send', '--terminal', terminalId, ...flags])

/** @type {import('orca/worker').Activate} */
export default async function activate(orca) {
  const saved = await orca.host.call('storage.get', { key: 'agents' })
  const agents = new Map(Object.entries(saved?.value ?? {}))
  let roots = { at: 0, list: [], workspaces: [] }

  // The host parses every panel answer with z.json(), which rejects an object holding `undefined`;
  // a round trip through JSON drops those keys, so no handler has to remember it.
  const handle = (name, fn) =>
    orca.panels.handle(name, async (input, context) =>
      JSON.parse(JSON.stringify((await fn(input, context)) ?? null))
    )

  const notify = () => {
    clearTimeout(timer)
    timer = setTimeout(() => orca.panels.post('board.changed', {}), 200)
  }

  // Watches shared state plus every worktree's task definitions. Recomputed on each refresh so new worktrees join.
  function watchRepo(root) {
    const state = join(stateRoot(root), 'state')
    mkdirSync(state, { recursive: true })
    const folders = ['tasks', 'bugs', 'subtasks', 'features']
    for (const dir of [
      state,
      ...worktreePaths(root).flatMap((p) => folders.map((f) => join(p, '.orbit', f)))
    ]) {
      if (watchers.has(dir)) {
        continue
      }
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
    if (Date.now() - roots.at < ROOTS_TTL_MS) {
      return roots
    }
    const { workspaces } = await orca.host.call('workspace.list', {})
    const found = new Set()
    for (const w of workspaces) {
      if (w.kind !== 'worktree') {
        continue
      }
      try {
        const root = findPrimaryRoot(w.path)
        if (usesOrbit(root)) {
          found.add(root)
        }
      } catch {
        // remote or deleted worktree: not readable from this machine
      }
    }
    for (const root of found) {
      watchRepo(root)
    }
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
      if (a.state === 'done' && Date.now() - a.receivedAt > DONE_AGENT_TTL_MS) {
        agents.delete(key)
      }
    }
    await orca.host.call('storage.set', { key: 'agents', value: Object.fromEntries(agents) })
    notify()
  })

  // Hooks decide in-process first: Orca gives each 2s and passes the action through on timeout.
  orca.hooks.on('agent.tool.before', async (e) => {
    if (!isGuardedTool(e.tool) || !e.workspaceId) {
      return
    }
    const mode = await orca.settings.get('guardMode')
    if (mode !== 'block') {
      return
    }
    // The event id carries the path; workspace.list ids use another scheme, so it is only a fallback.
    const workspacePath =
      workspacePathOf(e.workspaceId) ??
      (await repoRoots()).workspaces.find((w) => w.id === e.workspaceId)?.path
    if (!workspacePath) {
      return
    }
    let tasks = []
    try {
      tasks = listWork(workspacePath)
    } catch {
      return // not a git checkout readable here
    }
    return (
      decideTool({
        mode,
        tool: e.tool,
        input: e.input,
        workspaceId: e.workspaceId,
        workspacePath,
        tasks,
        orbitCommand: ORBIT_COMMAND
      }) ?? undefined
    )
  })

  orca.hooks.on('agent.prompt.before', async (e, next) => {
    if (e.inputKind === 'driving' || (await orca.settings.get('guardMode')) === 'off') {
      return
    }
    if ((await repoRoots()).list.length === 0) {
      return
    } // no repo uses Orbit
    return next({ ...e, prompt: appendReminder(e.prompt) })
  })

  const label = (a) => a.title ?? a.paneKey
  const cliPath = async () =>
    (await orca.settings.get('orcaCli')) || (existsSync(bundledCli) ? bundledCli : 'orca')
  // An agent whose terminal was closed never sends a final event, so it would stay "working" forever.
  // Ask the Orca CLI which terminals exist; when it cannot answer (or truncates), keep what we know.
  let terminalCache = { at: 0, handles: null }
  async function liveTerminals() {
    if (Date.now() - terminalCache.at < ROOTS_TTL_MS) {
      return terminalCache.handles
    }
    let handles = null
    try {
      const out = await orcaRun(await cliPath(), ['terminal', 'list'])
      if (!out.result?.truncated) {
        handles = new Set(out.result.terminals.map((t) => t.handle))
      }
    } catch {
      // no CLI: show every agent we know
    }
    terminalCache = { at: Date.now(), handles }
    return handles
  }
  async function liveAgents() {
    const all = [...agents.values()]
    if (!all.some((a) => a.terminalId)) {
      return all
    }
    const handles = await liveTerminals()
    return handles ? all.filter((a) => !a.terminalId || handles.has(a.terminalId)) : all
  }
  async function repoRootOrThrow(root) {
    if (!(await repoRoots()).list.includes(root)) {
      throw new Error('unknown repo')
    }
    return root
  }

  handle('task.get', async ({ root, id }) => {
    await repoRootOrThrow(root)
    const task = readTask(root, id)
    const { pause, skipped } = planPause({ task, agents: await liveAgents() })
    const feature = task.feature ? listFeatures(root).find((f) => f.id === task.feature) : null
    let size = null
    if (task.kind !== 'subtask') {
      const profile = profileFor(root, task.profile)
      const a = assess(task, profile)
      size = {
        profile: profile.name,
        agent: profile.agent,
        model: profile.model,
        effort: profile.effort,
        verdict: a.verdict,
        estTokens: a.estTokens ?? null,
        ratio: a.ratio ?? null,
        range: a.range ?? null,
        advice: a.advice ?? null
      }
    }
    const catalog = catalogFor(root)
    return {
      ...task,
      assignees: catalog.map(({ key, source }) => ({ key, source })),
      assigneeMissing: Boolean(task.assignee) && !catalog.some((e) => e.key === task.assignee),
      featureTitle: feature?.title ?? null,
      subtasks: listWork(root, { kind: 'subtask' })
        .filter((s) => s.parent === id)
        .map(({ id: sid, status, title }) => ({ id: sid, status, title })),
      size,
      profiles: Object.keys(readConfig(root).sizing.profiles),
      working: pause.map((a) => ({ title: label(a) })),
      notInterruptible: skipped.map((s) => ({ title: label(s.agent), reason: s.reason }))
    }
  })

  handle('feature.get', async ({ root, id }) => {
    await repoRootOrThrow(root)
    const feature = readFeature(root, id)
    const work = listWork(root)
    const rollup = rollupFeature(feature, work, listArchived(root))
    const children = work
      .filter((w) => w.feature === id)
      .map(({ id: cid, kind, status, title }) => ({ id: cid, kind, status, title }))
    return { ...rollup, body: feature.body, children }
  })

  handle('task.archive', async ({ root, id }) => {
    await repoRootOrThrow(root)
    const archived = archiveItem(root, id)
    notify()
    return { archived }
  })

  handle('archive.done', async ({ root }) => {
    await repoRootOrThrow(root)
    const result = archiveDone(root)
    notify()
    return result
  })

  // Starts an agent on the task with the model and effort of its profile. Needs the Orca CLI:
  // the plugin API's agent.launch has no model or effort.
  handle('task.run', async ({ root, id }) => {
    await repoRootOrThrow(root)
    const task = readTask(root, id)
    if (task.kind === 'subtask') {
      throw new Error('subtasks run inside their parent task')
    }
    if (task.status !== 'todo') {
      throw new Error(`only a todo task can be run (${id} is ${task.status})`)
    }
    const finished = new Set([
      ...listWork(root)
        .filter((w) => w.status === 'done')
        .map((w) => w.id),
      ...archivedIds(root)
    ])
    const waiting = (task.depends ?? []).filter((d) => !finished.has(d))
    if (waiting.length > 0) {
      throw new Error(`${id} waits for ${waiting.join(', ')}`)
    }
    const profile = profileFor(root, task.profile)
    const prompt = runPrompt({ id, orbitCommand: ORBIT_COMMAND, assignee: task.assignee })
    // The CLI resolves `active` from this process's cwd, which is not a worktree, so name one: the
    // focused worktree when it belongs to this repo, else the repo's own checkout.
    let worktree = root
    try {
      const { focus } = await focusState()
      if (focus.path && findPrimaryRoot(focus.path) === root) {
        worktree = focus.path
      }
    } catch {
      // focus is only a preference; the repo's own checkout always works
    }
    const out = await orcaRun(await cliPath(), [
      'agent',
      'launch',
      '--agent',
      profile.agent,
      '--model',
      profile.model,
      '--effort',
      profile.effort,
      '--surface',
      'terminal',
      '--worktree',
      `path:${worktree}`,
      '--prompt',
      prompt
    ])
    return {
      launched: true,
      terminal: out.result?.outcome?.handle ?? null,
      profile: profile.name,
      worktree
    }
  })

  // Saves the edit, then (optionally) interrupts agents working on the task and asks them to re-check.
  handle(
    'task.update',
    async ({ root, id, title, body, status, estTokens, profile, assignee, baseHash, pause }) => {
      await repoRootOrThrow(root)
      const { changed, hash, warning } = editTask(root, id, {
        title,
        body,
        status,
        estTokens,
        profile,
        assignee,
        baseHash
      })
      const result = { changed, hash, warning, paused: [], skipped: [] }
      if (!pause || !(changed.title || changed.body)) {
        return result
      }
      const plan = planPause({ task: readTask(root, id), agents: await liveAgents() })
      const skipped = plan.skipped.map((s) => ({ title: label(s.agent), reason: s.reason }))
      const cli = await cliPath()
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
      if (interruptFailure.size < plan.pause.length) {
        await new Promise((r) => setTimeout(r, INTERRUPT_GAP_MS))
      }

      const paused = []
      for (const a of plan.pause) {
        const whyNotInterrupted = interruptFailure.get(a.terminalId)
        try {
          // No CLI: the message still goes through the plugin API (focused worktree only) and queues.
          await (whyNotInterrupted
            ? orca.host.call('terminal.sendText', {
                terminalId: a.terminalId,
                text: message,
                enter: true
              })
            : orcaTerminalSend(cli, a.terminalId, '--text', message, '--enter'))
          if (whyNotInterrupted) {
            skipped.push({
              title: label(a),
              reason: `could not interrupt (${whyNotInterrupted}); the message was queued`
            })
          } else {
            paused.push(label(a))
          }
        } catch (error) {
          const reasons = [
            whyNotInterrupted && `could not interrupt (${whyNotInterrupted})`,
            `could not reach its terminal (${error.message})`
          ]
          skipped.push({ title: label(a), reason: reasons.filter(Boolean).join('; ') })
        }
      }
      notify()
      return { ...result, paused, skipped }
    }
  )

  const safeUsesOrbit = (path) => {
    try {
      return usesOrbit(path)
    } catch {
      return false // not a git checkout readable here
    }
  }

  // The three reads are independent; the terminal map is the only thing that needs the live agents.
  async function focusState() {
    const [live, { workspaces }, context] = await Promise.all([
      liveAgents(),
      repoRoots(),
      orca.host.call('workspace.readContext', {})
    ])
    const terminalWorkspace = new Map(
      live.filter((a) => a.terminalId).map((a) => [a.terminalId, a.workspaceId])
    )
    return {
      live,
      focus: resolveFocus(context, workspaces, { usesOrbit: safeUsesOrbit, terminalWorkspace })
    }
  }

  // The panel follows the focused project: only its repo and the agents running inside it.
  handle('board.get', async () => {
    const { live: agents, focus } = await focusState()
    const live = agents.sort((a, b) => b.receivedAt - a.receivedAt)
    const paths = focus.path ? [focus.path] : (focus.ambiguous ?? [])
    const shownRoots = [...new Set(paths.map(findPrimaryRoot))]
    const shown = agentsInRepo(live, shownRoots.flatMap(worktreePaths))
    const repos = []
    const taskOf = new Map()
    for (const root of shownRoots) {
      const work = listWork(root)
      const archived = listArchived(root)
      const archivedBoardItems = archived.filter((a) => a.kind === 'task' || a.kind === 'bug')
      // Subtasks live inside their task's session, so the board shows tasks and bugs only.
      const board = buildBoard(
        work.filter((w) => w.kind !== 'subtask'),
        shown,
        { archived: archivedBoardItems }
      )
      for (const a of board.agents) {
        if (a.taskId) {
          taskOf.set(a.paneKey, { taskId: a.taskId, repo: basename(root) })
        }
      }
      repos.push({
        root,
        name: basename(root),
        columns: board.columns,
        progress: board.progress,
        archivedCount: archivedBoardItems.length,
        features: listFeatures(root).map((f) => rollupFeature(f, work, archived))
      })
    }
    return {
      focus: focus.path
        ? 'project'
        : focus.ambiguous
          ? 'ambiguous'
          : focus.none
            ? 'none'
            : 'noFocus',
      repos,
      agents: shown.map((a) => ({ ...a, ...taskOf.get(a.paneKey) })),
      agentCounts: buildBoard([], shown).agentCounts
    }
  })
}
