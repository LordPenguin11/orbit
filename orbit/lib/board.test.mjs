import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildBoard } from './board.mjs'

const t = (id, status, extra = {}) => ({ id, title: id, status, owner: '', depends: [], ...extra })

test('groups_by_status', () => {
  const b = buildBoard([t('t-1', 'todo'), t('t-2', 'doing'), t('t-3', 'done')], [])
  assert.deepEqual(
    Object.fromEntries(Object.entries(b.columns).map(([k, v]) => [k, v.map((x) => x.id)])),
    { todo: ['t-1'], doing: ['t-2'], review: [], done: ['t-3'], blocked: [] }
  )
})

test('progress_counts_done_over_total', () => {
  const b = buildBoard([t('t-1', 'done'), t('t-2', 'done'), t('t-3', 'todo'), t('t-4', 'doing')], [])
  assert.deepEqual(b.progress, { done: 2, total: 4, pct: 50 })
  assert.deepEqual(buildBoard([], []).progress, { done: 0, total: 0, pct: 0 })
})

test('depends_unmet_marks_blocked', () => {
  const b = buildBoard(
    [t('t-1', 'doing'), t('t-2', 'todo', { depends: ['t-1'] }), t('t-3', 'todo', { depends: ['t-9'] })],
    []
  )
  assert.deepEqual(b.columns.todo, [])
  assert.deepEqual(
    b.columns.blocked.map((x) => [x.id, x.waitingOn]),
    [['t-2', ['t-1']], ['t-3', ['t-9']]]
  )
})

test('joins_agent_by_pane_key_or_workspace', () => {
  const agents = [
    { paneKey: 'pane-a', workspaceId: 'w1', state: 'working', title: 'A', receivedAt: 1 },
    { paneKey: 'pane-b', workspaceId: 'w2', state: 'waiting', title: 'B', receivedAt: 2 }
  ]
  const b = buildBoard(
    [t('t-1', 'doing', { owner: 'pane-a' }), t('t-2', 'doing', { owner: 'other', worktree: 'w2' }), t('t-3', 'doing', { owner: 'gone' })],
    agents
  )
  const by = Object.fromEntries(b.columns.doing.map((x) => [x.id, x.agent?.paneKey ?? null]))
  assert.deepEqual(by, { 't-1': 'pane-a', 't-2': 'pane-b', 't-3': null })
})

test('agents_report_task_and_counts', () => {
  const agents = [
    { paneKey: 'pane-a', workspaceId: 'w1', state: 'working', receivedAt: 1 },
    { paneKey: 'pane-b', workspaceId: 'w2', state: 'done', receivedAt: 2 },
    { paneKey: 'pane-c', workspaceId: null, state: 'blocked', receivedAt: 3 }
  ]
  const b = buildBoard([t('t-1', 'doing', { owner: 'pane-a' })], agents)
  assert.deepEqual(b.agents.map((a) => [a.paneKey, a.taskId ?? null]), [['pane-a', 't-1'], ['pane-b', null], ['pane-c', null]])
  assert.deepEqual(b.agentCounts, { total: 3, working: 1, blocked: 1, waiting: 0, done: 1 })
})
