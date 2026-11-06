import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, hostError, mockHost, mountWorker, test } from 'orca/testing'
import { archiveItem, claim, newItem, setStatus } from '../lib/store.mjs'
import * as main from './main.mjs'

function repoWithClaimedTask(): { dir: string; id: string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-worker-')))
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init')
  const { id } = newItem(dir, 'task', 'Write store', { plan: '', depends: [] })
  claim(dir, id, { owner: 'pane-1', workspace: dir })
  return { dir, id }
}

test('agent_event_joins_claimed_task_and_notifies_panel', async () => {
  const { dir, id } = repoWithClaimedTask()
  const host = mockHost({
    results: {
      'workspace.list': {
        workspaces: [{ id: 'w1', kind: 'worktree', name: 'main', path: dir, branch: 'main', hostId: null }],
        truncated: false
      },
      'workspace.readContext': { displayName: 'main', branch: 'main', terminals: [] }
    }
  })
  const worker = await mountWorker(main, { host })
  await worker.emit('agent.status.changed', {
    workspaceId: `w1::${dir}`,
    paneKey: 'pane-1',
    state: 'working',
    receivedAt: 1
  })
  const board = await worker.request('board.get', {})
  assert.equal(board.agents[0].taskId, id)
  assert.equal(board.agentCounts.working, 1)
  assert.equal(board.repos[0].columns.doing[0].id, id)
  await new Promise((r) => setTimeout(r, 300))
  assert.ok(worker.posts.some((p) => p.event === 'board.changed'))
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

function workspaceHost(dir: string, guardMode: string) {
  return mockHost({
    settings: { guardMode },
    results: {
      'workspace.list': {
        workspaces: [{ id: 'w1', kind: 'worktree', name: 'main', path: dir, branch: 'main', hostId: null }],
        truncated: false
      }
    }
  })
}
const editEvent = { agent: 'claude', workspaceId: 'w1', tool: 'Edit', input: { file_path: '/x/a.ts' } }

test('tool_hook_denies_edit_until_task_claimed_in_workspace', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-hook-')))
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init')
  const { id } = newItem(dir, 'task', 'Work', { plan: '', depends: [] })

  const worker = await mountWorker(main, { host: workspaceHost(dir, 'block') })
  const denied = await worker.hooks.fire('agent.tool.before', editEvent)
  assert.equal(denied.kind, 'deny')
  assert.match(denied.reason, /task claim/)

  claim(dir, id, { owner: 'pane-1', workspace: dir, worktree: 'w1' })
  assert.equal((await worker.hooks.fire('agent.tool.before', editEvent)).kind, 'continue')
  await worker.deactivate()

  const off = await mountWorker(main, { host: workspaceHost(dir, 'off') })
  claim(dir, id, { owner: 'pane-1', workspace: dir, worktree: 'other' })
  assert.equal((await off.hooks.fire('agent.tool.before', editEvent)).kind, 'continue')
  await off.deactivate()
})

test('prompt_hook_reminds_launch_prompts_but_not_typed_ones', async () => {
  const { dir } = repoWithClaimedTask()
  const worker = await mountWorker(main, { host: workspaceHost(dir, 'block') })
  const launch = await worker.hooks.fire('agent.prompt.before', {
    agent: 'claude', terminalId: 't1', prompt: 'fix bug', inputKind: 'launch'
  })
  assert.equal(launch.kind, 'continue')
  assert.match(launch.event.prompt, /orbit-project/)
  const typed = await worker.hooks.fire('agent.prompt.before', {
    agent: 'claude', terminalId: 't1', prompt: 'fix bug', inputKind: 'driving'
  })
  assert.equal(typed.event.prompt, 'fix bug')
  await worker.deactivate()
})

test('tool_hook_uses_path_from_event_workspace_id_without_workspace_list', async () => {
  const { dir, id } = repoWithClaimedTask()
  const worker = await mountWorker(main, { host: mockHost({ settings: { guardMode: 'block' } }) })
  const event = { agent: 'claude', workspaceId: `uuid-1::${dir}`, tool: 'Write', input: { file_path: `${dir}/a.ts` } }
  assert.equal((await worker.hooks.fire('agent.tool.before', event)).kind, 'continue') // claimed by path
  claim(dir, id, { owner: 'pane-1', workspace: '/elsewhere', worktree: 'other' })
  assert.equal((await worker.hooks.fire('agent.tool.before', event)).kind, 'deny')
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

function twoRepos() {
  const a = repoWithClaimedTask().dir
  const b = repoWithClaimedTask().dir
  const plain = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-plain-')))
  const git = (...x: string[]) => execFileSync('git', x, { cwd: plain, stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init')
  return { a, b, plain }
}
const entry = (path: string, name: string) => ({ id: `identity:${name}`, kind: 'worktree', name, path, branch: 'main', hostId: null })
function focusedHost(list: ReturnType<typeof entry>[], focus: string | null) {
  return mockHost({
    results: {
      'workspace.list': { workspaces: list, truncated: false },
      'workspace.readContext': focus ? { displayName: focus, branch: 'main', terminals: [] } : null
    }
  })
}

test('board_follows_the_focused_project_and_its_agents_only', async () => {
  const { a, b, plain } = twoRepos()
  const list = [entry(a, 'proj-a'), entry(b, 'proj-b'), entry(plain, 'proj-plain')]
  const status = (path: string, key: string) => ({ workspaceId: `u::${path}`, paneKey: key, state: 'working', receivedAt: 1 })

  const onA = await mountWorker(main, { host: focusedHost(list, 'proj-a') })
  await onA.emit('agent.status.changed', status(a, 'pane-a'))
  await onA.emit('agent.status.changed', status(b, 'pane-b'))
  const boardA = await onA.request('board.get', {})
  assert.equal(boardA.focus, 'project')
  assert.deepEqual(boardA.repos.map((r) => r.root), [a])
  assert.deepEqual(boardA.agents.map((x) => x.paneKey), ['pane-a'])
  await onA.deactivate()

  const onPlain = await mountWorker(main, { host: focusedHost(list, 'proj-plain') })
  const boardPlain = await onPlain.request('board.get', {})
  assert.equal(boardPlain.focus, 'none')
  assert.deepEqual([boardPlain.repos, boardPlain.agents], [[], []])
  await onPlain.deactivate()

  const nothing = await mountWorker(main, { host: focusedHost(list, null) })
  assert.equal((await nothing.request('board.get', {})).focus, 'noFocus')
  await nothing.deactivate()
})

test('same_named_workspaces_resolve_to_the_repo_that_uses_orbit', async () => {
  const { a, plain } = twoRepos()
  const list = [entry(plain, 'main'), entry(a, 'main')]
  const worker = await mountWorker(main, { host: focusedHost(list, 'main') })
  const board = await worker.request('board.get', {})
  assert.deepEqual([board.focus, board.repos.map((r) => r.root)], ['project', [a]])
  await worker.deactivate()
})

async function editHarness(agentState: string, settings: Record<string, string> = { orcaCli: fakeCli().path }) {
  const { dir, id } = repoWithClaimedTask() // task claimed by owner 'pane-1', status doing
  const host = mockHost({
    results: {
      'workspace.list': { workspaces: [entry(dir, 'proj')], truncated: false },
      'terminal.sendText': { accepted: true }
    },
    settings
  })
  const worker = await mountWorker(main, { host })
  await worker.emit('agent.status.changed', {
    workspaceId: `u::${dir}`, paneKey: 'pane-1', terminalId: 'term-1', title: 'Claude', state: agentState, receivedAt: 1
  })
  const opened = await worker.request('task.get', { root: dir, id })
  return { dir, id, worker, opened }
}
// A stand-in for the orca CLI: logs its arguments, answers like `--json`. `terminal list` reports `live`
// handles and is not logged, so call counts only cover what the plugin did to terminals and agents.
function fakeCli(live: string[] = ['term-1']): { path: string; calls: () => string[][] } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-cli-')))
  const log = join(dir, 'calls.jsonl')
  const path = join(dir, 'orca')
  writeFileSync(path, `#!/usr/bin/env node
const args = process.argv.slice(2)
if (args[0] === 'terminal' && args[1] === 'list') {
  console.log(JSON.stringify({ ok: true, result: { terminals: ${JSON.stringify(live)}.map((handle) => ({ handle })), truncated: false } }))
  process.exit(0)
}
require('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n')
console.log(JSON.stringify({ ok: true, result: { outcome: { handle: 'term-fake' } } }))
`)
  chmodSync(path, 0o755)
  return { path, calls: () => { try { return readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) } catch { return [] } } }
}
const sent = (worker: Awaited<ReturnType<typeof mountWorker>>) =>
  worker.host.callsOf('terminal.sendText').map((c) => JSON.stringify(c))

test('task_get_returns_the_detail_and_who_is_working_on_it', async () => {
  const { id, worker, opened } = await editHarness('working')
  assert.equal(opened.id, id)
  assert.match(opened.body, /## Goal/)
  assert.deepEqual(opened.working.map((a) => a.title), ['Claude'])
  await worker.deactivate()
})

test('task_update_interrupts_through_the_orca_cli_then_types_the_diff_message', async () => {
  const cli = fakeCli()
  const { dir, id, worker, opened } = await editHarness('working', { orcaCli: cli.path })
  try {
    const r = await worker.request('task.update', {
      root: dir, id, title: 'Edited title', body: opened.body, baseHash: opened.hash, pause: true
    })
    assert.equal(r.changed.title, true)
    assert.deepEqual(r.paused, ['Claude'])
    assert.deepEqual(r.skipped, [])
    const calls = cli.calls()
    assert.equal(calls.length, 2)
    assert.deepEqual(calls[0].slice(0, 5), ['terminal', 'send', '--terminal', 'term-1', '--interrupt'])
    assert.deepEqual(calls[1].slice(0, 4), ['terminal', 'send', '--terminal', 'term-1'])
    assert.ok(calls[1].includes('--enter'))
    assert.match(calls[1][calls[1].indexOf('--text') + 1], new RegExp(`task diff ${id}`))
    assert.deepEqual(sent(worker), [], 'the CLI path does not use terminal.sendText')
    assert.deepEqual(worker.refusals, [])
  } finally {
    await worker.deactivate()
  }
})

test('task_update_falls_back_to_a_queued_message_when_the_cli_cannot_run', async () => {
  const { dir, id, worker, opened } = await editHarness('working', { orcaCli: '/nonexistent/orca' })
  try {
    const r = await worker.request('task.update', {
      root: dir, id, title: 'Edited', body: opened.body, baseHash: opened.hash, pause: true
    })
    assert.deepEqual(r.paused, [])
    assert.match(r.skipped[0].reason, /could not interrupt/)
    const calls = sent(worker)
    assert.equal(calls.length, 1, 'only the message, no ESC')
    assert.match(calls[0], new RegExp(`task diff ${id}`))
  } finally {
    await worker.deactivate()
  }
})

test('task_update_does_not_touch_terminals_when_pause_is_off_or_only_status_changed', async () => {
  const { dir, id, worker, opened } = await editHarness('working')
  await worker.request('task.update', { root: dir, id, title: 'Quiet edit', body: opened.body, baseHash: opened.hash, pause: false })
  const reopened = await worker.request('task.get', { root: dir, id })
  await worker.request('task.update', { root: dir, id, status: 'review', title: reopened.title, body: reopened.body, baseHash: reopened.hash, pause: true })
  assert.deepEqual(sent(worker), [])
  await worker.deactivate()
})

test('task_update_skips_an_agent_that_is_waiting_and_reports_why', async () => {
  const { dir, id, worker, opened } = await editHarness('waiting')
  const r = await worker.request('task.update', { root: dir, id, title: 'Edit', body: opened.body, baseHash: opened.hash, pause: true })
  assert.deepEqual(sent(worker), [])
  assert.match(r.skipped[0].reason, /waiting/)
  await worker.deactivate()
})

test('task_update_rejects_a_stale_hash_and_unknown_repos', async () => {
  const { dir, id, worker, opened } = await editHarness('working')
  await worker.request('task.update', { root: dir, id, title: 'First', body: opened.body, baseHash: opened.hash, pause: false })
  await assert.rejects(worker.request('task.update', { root: dir, id, title: 'Stale', body: opened.body, baseHash: opened.hash, pause: false }), /changed since/)
  await assert.rejects(worker.request('task.get', { root: '/not/a/known/repo', id }), /unknown repo/)
  await worker.deactivate()
})

test('task_update_reports_an_unreachable_terminal_instead_of_failing_the_save', async () => {
  const { dir, id } = repoWithClaimedTask()
  const host = mockHost({
    results: {
      'workspace.list': { workspaces: [entry(dir, 'proj')], truncated: false },
      'terminal.sendText': () => {
        throw hostError('not_permitted', 'terminal is outside the active worktree')
      }
    },
    settings: { orcaCli: '/nonexistent/orca' }
  })
  const worker = await mountWorker(main, { host })
  await worker.emit('agent.status.changed', {
    workspaceId: `u::${dir}`, paneKey: 'pane-1', terminalId: 'term-1', title: 'Claude', state: 'working', receivedAt: 1
  })
  try {
    const opened = await worker.request('task.get', { root: dir, id })
    const r = await worker.request('task.update', { root: dir, id, title: 'Saved anyway', body: opened.body, baseHash: opened.hash, pause: true })
    assert.equal(r.changed.title, true)
    assert.deepEqual(r.paused, [])
    assert.match(r.skipped[0].reason, /outside the active worktree/)
    assert.equal((await worker.request('task.get', { root: dir, id })).title, 'Saved anyway')
  } finally {
    await worker.deactivate() // a failing assert must not leave fs watchers holding the process open
  }
})

function newRepo() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-m3-')))
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init')
  return dir
}
const mk = (dir: string, kind: string, title: string, opts: Record<string, unknown> = {}) => newItem(dir, kind, title, opts).id
async function m3Worker(dir: string, settings: Record<string, string> = {}) {
  const host = mockHost({
    results: {
      'workspace.list': { workspaces: [entry(dir, 'proj')], truncated: false },
      'workspace.readContext': { displayName: 'proj', branch: 'main', terminals: [] }
    },
    settings
  })
  return mountWorker(main, { host })
}

test('board_lists_tasks_and_bugs_with_qa_features_rollup_and_archived_progress', async () => {
  const dir = newRepo()
  const f = mk(dir, 'feature', 'Checkout')
  const done = mk(dir, 'task', 'Shipped', { feature: f })
  const inQa = mk(dir, 'task', 'In QA', { feature: f })
  const bug = mk(dir, 'bug', 'Crash', { feature: f })
  mk(dir, 'subtask', 'Child', { parent: inQa })
  setStatus(dir, done, 'done')
  archiveItem(dir, done)
  setStatus(dir, inQa, 'qa')
  const worker = await m3Worker(dir)
  try {
    const repo = (await worker.request('board.get', {})).repos[0]
    assert.deepEqual(repo.columns.qa.map((t) => t.id), [inQa])
    assert.deepEqual(repo.columns.todo.map((t) => [t.id, t.kind]), [[bug, 'bug']])
    assert.equal(JSON.stringify(repo.columns).includes('s-1'), false, 'subtasks are not board items')
    assert.deepEqual(repo.progress, { done: 1, total: 3, pct: 33 })
    assert.equal(repo.archivedCount, 1)
    assert.deepEqual(repo.features.map((x) => [x.id, x.total, x.done, x.status]), [[f, 3, 1, 'doing']])
  } finally {
    await worker.deactivate()
  }
})

test('task_get_adds_kind_subtasks_feature_size_and_the_profile_names', async () => {
  const dir = newRepo()
  const f = mk(dir, 'feature', 'Checkout')
  const t = mk(dir, 'task', 'Build form', { feature: f, estTokens: '80000' })
  const s = mk(dir, 'subtask', 'Validate', { parent: t })
  const worker = await m3Worker(dir)
  try {
    const got = await worker.request('task.get', { root: dir, id: t })
    assert.equal(got.kind, 'task')
    assert.equal(got.featureTitle, 'Checkout')
    assert.deepEqual(got.subtasks, [{ id: s, status: 'todo', title: 'Validate' }])
    assert.deepEqual([got.size.profile, got.size.verdict, got.size.ratio], ['sonnet-medium', 'ok', 0.4])
    assert.deepEqual(got.profiles, ['haiku-low', 'sonnet-medium', 'opus-high'])
    assert.equal((await worker.request('task.get', { root: dir, id: s })).size, null, 'subtasks are not sized')
  } finally {
    await worker.deactivate()
  }
})

test('task_update_passes_size_fields_through_and_never_interrupts_for_them', async () => {
  const dir = newRepo()
  const t = mk(dir, 'task', 'T')
  const worker = await m3Worker(dir)
  try {
    const got = await worker.request('task.get', { root: dir, id: t })
    const r = await worker.request('task.update', { root: dir, id: t, estTokens: '30000', profile: 'haiku-low', baseHash: got.hash, pause: true })
    assert.deepEqual([r.changed.fields, r.paused], [true, []])
    assert.deepEqual((await worker.request('task.get', { root: dir, id: t })).size.profile, 'haiku-low')
  } finally {
    await worker.deactivate()
  }
})

test('archive_handlers_move_done_work_and_report_the_rest', async () => {
  const dir = newRepo()
  const a = mk(dir, 'task', 'Done one')
  const b = mk(dir, 'task', 'Still open')
  setStatus(dir, a, 'done')
  const worker = await m3Worker(dir)
  try {
    await assert.rejects(worker.request('task.archive', { root: dir, id: b }), /only done items/)
    assert.deepEqual((await worker.request('task.archive', { root: dir, id: a })).archived, [a])
    const c = mk(dir, 'task', 'Done two')
    setStatus(dir, c, 'done')
    const all = await worker.request('archive.done', { root: dir })
    assert.deepEqual([all.archived, all.skipped], [[c], []])
  } finally {
    await worker.deactivate()
  }
})

test('task_run_launches_an_agent_with_the_profile_model_and_effort', async () => {
  const cli = fakeCli()
  const dir = newRepo()
  const t = mk(dir, 'task', 'Runnable', { profile: 'opus-high' })
  const worker = await m3Worker(dir, { orcaCli: cli.path })
  try {
    const r = await worker.request('task.run', { root: dir, id: t })
    assert.deepEqual([r.launched, r.terminal, r.profile], [true, 'term-fake', 'opus-high'])
    const [args] = cli.calls()
    assert.deepEqual(args.slice(0, 11), ['agent', 'launch', '--agent', 'claude', '--model', 'claude-opus-5-5', '--effort', 'high', '--surface', 'terminal', '--worktree'])
    assert.equal(args[11], 'active')
    const prompt = args[args.indexOf('--prompt') + 1]
    assert.match(prompt, new RegExp(`brief ${t}`))
    assert.match(prompt, new RegExp(`claim ${t}`))
  } finally {
    await worker.deactivate()
  }
})

test('task_run_refuses_what_is_not_ready', async () => {
  const cli = fakeCli()
  const dir = newRepo()
  const dep = mk(dir, 'task', 'Dependency')
  const waits = mk(dir, 'task', 'Waits', { depends: [dep] })
  const busy = mk(dir, 'task', 'Busy')
  setStatus(dir, busy, 'review')
  const sub = mk(dir, 'subtask', 'Child', { parent: busy })
  const worker = await m3Worker(dir, { orcaCli: cli.path })
  try {
    await assert.rejects(worker.request('task.run', { root: dir, id: waits }), new RegExp(`waits for ${dep}`))
    await assert.rejects(worker.request('task.run', { root: dir, id: busy }), /only a todo task/)
    await assert.rejects(worker.request('task.run', { root: dir, id: sub }), /subtasks run inside their parent/)
    assert.deepEqual(cli.calls(), [])
  } finally {
    await worker.deactivate()
  }
})

test('feature_get_returns_the_rollup_children_and_body', async () => {
  const dir = newRepo()
  const f = mk(dir, 'feature', 'Checkout')
  const t = mk(dir, 'task', 'Build form', { feature: f })
  const b = mk(dir, 'bug', 'Crash', { feature: f })
  setStatus(dir, t, 'done')
  const worker = await m3Worker(dir)
  try {
    const got = await worker.request('feature.get', { root: dir, id: f })
    assert.deepEqual([got.id, got.title, got.total, got.done, got.openBugs], [f, 'Checkout', 2, 1, 1])
    assert.deepEqual(got.children.map((c) => [c.id, c.kind, c.status]), [[t, 'task', 'done'], [b, 'bug', 'todo']])
    assert.match(got.body, /## Acceptance/)
  } finally {
    await worker.deactivate()
  }
})

test('agents_whose_terminal_is_gone_are_dropped_but_a_missing_cli_prunes_nothing', async () => {
  const dir = newRepo()
  mk(dir, 'task', 'T')
  const status = (key: string, terminal: string) => ({ workspaceId: `u::${dir}`, paneKey: key, terminalId: terminal, title: key, state: 'working', receivedAt: 1 })
  const run = async (orcaCli: string) => {
    const worker = await m3Worker(dir, { orcaCli })
    try {
      await worker.emit('agent.status.changed', status('alive', 'term-live'))
      await worker.emit('agent.status.changed', status('closed', 'term-gone'))
      const board = await worker.request('board.get', {})
      return [board.agents.map((a) => a.paneKey).sort(), board.agentCounts.working]
    } finally {
      await worker.deactivate()
    }
  }
  assert.deepEqual(await run(fakeCli(['term-live']).path), [['alive'], 1])
  assert.deepEqual(await run('/nonexistent/orca'), [['alive', 'closed'], 2], 'when the CLI cannot answer, show what we know')
})

// Agents and skills come from a fake home (ORBIT_HOME), never the machine's real one.
async function withHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-home-')))
  for (const name of ['swift-expert', 'android-expert']) {
    mkdirSync(join(home, '.claude', 'agents'), { recursive: true })
    writeFileSync(join(home, '.claude', 'agents', `${name}.md`), `---\nname: ${name}\n---\n`)
  }
  mkdirSync(join(home, '.claude', 'skills', 'design-review'), { recursive: true })
  writeFileSync(join(home, '.claude', 'skills', 'design-review', 'SKILL.md'), '---\nname: design-review\n---\n')
  const before = process.env.ORBIT_HOME
  process.env.ORBIT_HOME = home
  try {
    return await fn(home)
  } finally {
    if (before === undefined) delete process.env.ORBIT_HOME
    else process.env.ORBIT_HOME = before
  }
}

test('task_get_lists_the_assignee_catalog_and_flags_an_assignee_that_disappeared', async () => {
  await withHome(async (home) => {
    const dir = newRepo()
    const t = mk(dir, 'task', 'Assigned', { assignee: 'swift-expert' })
    const worker = await m3Worker(dir)
    try {
      const got = await worker.request('task.get', { root: dir, id: t })
      assert.equal(got.assignee, 'agent:swift-expert')
      assert.equal(got.assigneeMissing, false)
      assert.deepEqual(got.assignees.map((a) => a.key), ['agent:android-expert', 'agent:swift-expert', 'skill:design-review'])
      assert.equal(got.assignees[0].source, 'user')
      rmSync(join(home, '.claude', 'agents', 'swift-expert.md'))
      assert.equal((await worker.request('task.get', { root: dir, id: t })).assigneeMissing, true)
    } finally {
      await worker.deactivate()
    }
  })
})

test('task_update_sets_and_clears_the_assignee_without_interrupting_anyone', async () => {
  await withHome(async () => {
    const dir = newRepo()
    const t = mk(dir, 'task', 'T')
    const worker = await m3Worker(dir)
    try {
      const got = await worker.request('task.get', { root: dir, id: t })
      const r = await worker.request('task.update', { root: dir, id: t, assignee: 'agent:android-expert', baseHash: got.hash, pause: true })
      assert.deepEqual([r.changed.fields, r.paused], [true, []])
      assert.equal((await worker.request('task.get', { root: dir, id: t })).assignee, 'agent:android-expert')
      await assert.rejects(worker.request('task.update', { root: dir, id: t, assignee: 'nobody', baseHash: (await worker.request('task.get', { root: dir, id: t })).hash, pause: false }), /unknown assignee/)
    } finally {
      await worker.deactivate()
    }
  })
})

test('task_run_asks_the_session_to_use_the_assignee', async () => {
  await withHome(async () => {
    const cli = fakeCli()
    const dir = newRepo()
    const t = mk(dir, 'task', 'Runnable', { assignee: 'swift-expert' })
    const worker = await m3Worker(dir, { orcaCli: cli.path })
    try {
      await worker.request('task.run', { root: dir, id: t })
      const [args] = cli.calls()
      assert.match(args[args.indexOf('--prompt') + 1], /subagent_type "swift-expert"/)
    } finally {
      await worker.deactivate()
    }
  })
})
