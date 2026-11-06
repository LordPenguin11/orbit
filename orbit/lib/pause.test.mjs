import assert from 'node:assert/strict'
import { test } from 'node:test'
import { planPause, taskEditedMessage } from './pause.mjs'

const agent = (over = {}) => ({ paneKey: 'p1', terminalId: 't1', workspaceId: 'w1', state: 'working', title: 'A', ...over })
const doing = (over = {}) => ({ id: 't-3', status: 'doing', owner: 'p1', worktree: 'w1', ...over })

test('only_working_agents_on_a_doing_task_are_paused', () => {
  const r = planPause({ task: doing(), agents: [agent(), agent({ paneKey: 'p9', terminalId: 't9', workspaceId: 'w9' })] })
  assert.deepEqual(r.pause.map((a) => a.terminalId), ['t1'])
  assert.deepEqual(r.skipped, [])
})

test('waiting_and_blocked_agents_are_skipped_because_they_may_be_asking_permission', () => {
  for (const state of ['waiting', 'blocked', 'done']) {
    const r = planPause({ task: doing(), agents: [agent({ state })] })
    assert.deepEqual(r.pause, [])
    assert.match(r.skipped[0].reason, new RegExp(state))
  }
})

test('tasks_that_are_not_doing_pause_nobody', () => {
  for (const status of ['todo', 'review', 'done', 'blocked']) {
    assert.deepEqual(planPause({ task: doing({ status }), agents: [agent()] }), { pause: [], skipped: [] })
  }
})

test('agent_matches_by_owner_pane_key_or_by_worktree_id_and_is_not_duplicated', () => {
  const byWorktree = planPause({ task: doing({ owner: 'custom-name' }), agents: [agent()] })
  assert.equal(byWorktree.pause.length, 1)
  const twice = planPause({ task: doing(), agents: [agent(), agent({ paneKey: 'p2' })] })
  assert.equal(twice.pause.length, 1)
})

test('agent_without_a_terminal_is_skipped', () => {
  const r = planPause({ task: doing(), agents: [agent({ terminalId: null })] })
  assert.deepEqual(r.pause, [])
  assert.match(r.skipped[0].reason, /terminal/)
})

test('message_is_one_line_and_names_the_diff_command', () => {
  const m = taskEditedMessage('t-3', 'node /x/orbit.mjs')
  assert.doesNotMatch(m, /\n/)
  assert.match(m, /node \/x\/orbit\.mjs task diff t-3/)
})

test('another_agent_in_the_same_workspace_is_not_interrupted_when_the_owner_is_known', () => {
  const owner = agent({ paneKey: 'p-owner', terminalId: 't-owner', workspaceId: 'other' })
  const bystander = agent({ paneKey: 'p-me', terminalId: 't-me', workspaceId: 'w1' })
  const r = planPause({ task: doing({ owner: 'p-owner', worktree: 'w1' }), agents: [bystander, owner] })
  assert.deepEqual(r.pause.map((a) => a.terminalId), ['t-owner'])
})
