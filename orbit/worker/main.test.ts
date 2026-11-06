import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import { claim, newItem } from '../lib/store.mjs'
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
