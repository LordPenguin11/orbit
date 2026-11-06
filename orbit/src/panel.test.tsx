import { afterEach, assert, mockHost, mount, test, type TestPanel } from 'orca/testing'
import * as panelModule from './panel'

const LONG = 'A task title that is much longer than the panel can show on one line'
const empty = { todo: [], doing: [], review: [], qa: [], done: [], blocked: [] }
const board = {
  focus: 'project',
  repos: [
    {
      root: '/repo',
      name: 'repo',
      progress: { done: 0, total: 2, pct: 0 },
      archivedCount: 0,
      features: [],
      columns: {
        ...empty,
        doing: [{ id: 't-4', kind: 'task', title: LONG, status: 'doing', agent: { state: 'working', title: 'Claude' } }],
        review: [{ id: 't-5', kind: 'task', title: 'Short one', status: 'review' }]
      }
    }
  ],
  agents: [],
  agentCounts: { total: 0, working: 0, blocked: 0, waiting: 0, done: 0 }
}
const detail = {
  id: 't-4',
  kind: 'task',
  title: LONG,
  status: 'doing',
  featureTitle: null,
  subtasks: [],
  size: null,
  profiles: ['haiku-low', 'sonnet-medium'],
  assignees: [{ key: 'agent:swift-expert', source: 'user' }, { key: 'skill:design-review', source: 'workspace' }],
  assigneeMissing: false,
  plan: 'p-1',
  depends: [],
  body: '\n## Goal\n\nDo the thing.\n',
  hash: 'h1',
  working: [{ title: 'Claude' }],
  notInterruptible: []
}

let panel: TestPanel | undefined
afterEach(() => panel?.unmount())

function setup(update: (input: unknown) => unknown = () => ({ changed: { title: true, body: false, status: false }, hash: 'h2', paused: ['Claude'], skipped: [] })) {
  const updates: unknown[] = []
  const host = mockHost({
    requests: {
      'board.get': () => board,
      'task.get': () => detail,
      'task.update': (input: unknown) => {
        updates.push(input)
        return update(input)
      }
    }
  })
  return { host, updates }
}

test('items_are_one_short_line_and_open_the_detail_view', async () => {
  const { host } = setup()
  panel = await mount(panelModule, { host })
  assert.ok(panel.find({ text: 't-5 Short one' }))
  assert.ok(panel.find({ text: new RegExp(`^t-4 ${LONG.slice(0, 20)}.*…$`) }), 'long titles are cut with an ellipsis')
  assert.equal(panel.find({ text: new RegExp(LONG) }), null, 'the full title is not on the board')

  await panel.press({ text: /^t-4 / })
  assert.ok(panel.find({ text: new RegExp(`t-4 ${LONG}`) }), 'detail shows the full title')
  assert.ok(panel.find({ text: /Claude working/ }))
  await panel.press({ text: 'Back' })
  assert.ok(panel.find({ text: 't-5 Short one' }))
  assert.deepEqual(panel.errors, [])
})

test('edit_saves_with_the_opened_hash_and_the_pause_choice', async () => {
  const { host, updates } = setup()
  panel = await mount(panelModule, { host })
  await panel.press({ text: /^t-4 / })
  await panel.press({ text: 'Edit' })
  await panel.type({ label: 'Title' }, 'Renamed', { replace: true })
  await panel.select({ label: 'Status' }, 'review')
  await panel.toggle({ label: /Interrupt agents/ }) // on by default: turn it off
  await panel.press({ text: 'Save' })
  assert.deepEqual(updates, [
    { root: '/repo', id: 't-4', title: 'Renamed', body: detail.body, status: 'review', estTokens: '', profile: '', assignee: '', baseHash: 'h1', pause: false }
  ])
  assert.ok(panel.find({ text: /Saved\./ }))
  assert.deepEqual(panel.errors, [])
})

test('save_reports_interrupted_and_skipped_agents', async () => {
  const { host } = setup(() => ({
    changed: { title: true, body: false, status: false },
    hash: 'h2',
    paused: ['Claude'],
    skipped: [{ title: 'Codex', reason: 'agent is waiting, not interrupted' }]
  }))
  panel = await mount(panelModule, { host })
  await panel.press({ text: /^t-4 / })
  await panel.press({ text: 'Edit' })
  await panel.press({ text: 'Save' })
  assert.ok(panel.find({ text: /Interrupted Claude and asked to re-check/ }))
  assert.ok(panel.find({ text: /Codex not interrupted: agent is waiting/ }))
})

test('a_concurrent_edit_keeps_the_draft_and_offers_reload', async () => {
  const { host } = setup(() => {
    throw new Error('task t-4 changed since you opened it')
  })
  panel = await mount(panelModule, { host })
  await panel.press({ text: /^t-4 / })
  await panel.press({ text: 'Edit' })
  await panel.type({ label: 'Title' }, ' edited')
  await panel.press({ text: 'Save' })
  assert.ok(panel.find({ text: /changed while you were editing/ }))
  assert.ok(panel.find({ text: 'Reload latest' }))
  assert.ok(String(panel.valueOf({ label: 'Title' })).endsWith('edited'), 'the draft is still there')
})

const featureDetail = {
  id: 'f-1', title: 'Checkout', status: 'doing', total: 2, done: 1, pct: 50, openBugs: 1,
  subtasks: { total: 0, done: 0 }, body: '\n## Goal\n\nUsers can pay.\n',
  children: [{ id: 't-4', kind: 'task', status: 'doing', title: 'Build form' }, { id: 'b-1', kind: 'bug', status: 'todo', title: 'Crash on submit' }]
}
const rich = (over: Record<string, unknown> = {}) => {
  const calls: { name: string; input: unknown }[] = []
  const rec = (name: string, out: unknown) => (input: unknown) => {
    calls.push({ name, input })
    return out
  }
  const withFeatures = {
    ...board,
    repos: [{ ...board.repos[0], features: [{ id: 'f-1', title: 'Checkout', status: 'doing', total: 2, done: 1, pct: 50, openBugs: 1, subtasks: { total: 0, done: 0 } }],
      columns: { ...board.repos[0].columns, todo: [{ id: 'b-1', kind: 'bug', title: 'Crash on submit', status: 'todo' }], done: [{ id: 't-9', kind: 'task', title: 'Old', status: 'done' }] } }]
  }
  const host = mockHost({
    requests: {
      'board.get': rec('board.get', withFeatures),
      'task.get': rec('task.get', detail),
      'feature.get': rec('feature.get', featureDetail),
      'task.update': rec('task.update', { changed: { title: false, body: false, status: false, fields: true }, hash: 'h2', paused: [], skipped: [] }),
      'task.run': rec('task.run', { launched: true, terminal: 't', profile: 'sonnet-medium' }),
      'task.archive': rec('task.archive', { archived: ['t-9'] }),
      'archive.done': rec('archive.done', { archived: ['t-9'], skipped: [] }),
      ...over
    }
  })
  return { host, calls }
}

test('features_list_opens_a_feature_whose_children_open_tasks_and_back_returns_to_the_feature', async () => {
  const { host } = rich()
  panel = await mount(panelModule, { host })
  await panel.press({ text: /^f-1 Checkout/ })
  assert.ok(panel.find({ text: /f-1 Checkout/ }))
  assert.ok(panel.find({ text: '1 open bug' }), 'the feature view is open')
  await panel.press({ text: /^t-4 Build form/ })
  assert.ok(panel.find({ text: new RegExp(`t-4 ${LONG}`) }))
  await panel.press({ text: 'Back' })
  assert.ok(panel.find({ text: '1 open bug' }), 'back lands on the feature, not the board')
  await panel.press({ text: 'Back' })
  assert.equal(panel.find({ text: '1 open bug' }), null)
  assert.ok(panel.find({ text: /^f-1 Checkout/ }), 'a second back reaches the board')
})

test('a_todo_task_can_be_run_and_the_result_is_shown', async () => {
  const { host, calls } = rich({ 'task.get': () => ({ ...detail, status: 'todo', working: [], notInterruptible: [] }) })
  panel = await mount(panelModule, { host })
  await panel.press({ text: /^t-4 / })
  await panel.press({ text: 'Run' })
  assert.deepEqual(calls.find((c) => c.name === 'task.run')?.input, { root: '/repo', id: 't-4' })
  assert.ok(panel.find({ text: /Started an agent on t-4 with profile sonnet-medium/ }))
})

test('run_is_hidden_unless_the_task_is_todo_and_archive_appears_only_when_done', async () => {
  const doing = rich()
  panel = await mount(panelModule, { host: doing.host })
  await panel.press({ text: /^t-4 / })
  assert.equal(panel.find({ text: 'Run' }), null)
  assert.equal(panel.find({ text: 'Archive' }), null)
  await panel.unmount()
  const finished = rich({ 'task.get': () => ({ ...detail, status: 'done', working: [], notInterruptible: [] }) })
  panel = await mount(panelModule, { host: finished.host })
  await panel.press({ text: /^t-4 / })
  assert.ok(panel.find({ text: 'Archive' }))
})

test('archive_all_done_calls_the_worker_and_reports', async () => {
  const { host, calls } = rich()
  panel = await mount(panelModule, { host })
  await panel.toggle({ text: /^Done \(1\)/ })
  await panel.press({ text: 'Archive all done' })
  assert.deepEqual(calls.find((c) => c.name === 'archive.done')?.input, { root: '/repo' })
  assert.ok(panel.find({ text: /Archived 1\./ }))
})

test('the_detail_shows_the_size_block_and_the_edit_form_sends_the_size_fields', async () => {
  const sized = {
    ...detail,
    estTokens: '30000',
    profile: 'haiku-low',
    size: { profile: 'haiku-low', agent: 'claude', model: 'claude-haiku-5-5', effort: 'low', verdict: 'too-small', estTokens: 30000, ratio: 0.25, range: { min: 58334, max: 115000 }, advice: 'merge with a neighbouring task' }
  }
  const { host, calls } = rich({ 'task.get': () => sized })
  panel = await mount(panelModule, { host })
  await panel.press({ text: /^t-4 / })
  assert.ok(panel.find({ text: /25% of a haiku-low session/ }))
  assert.ok(panel.find({ text: /merge with a neighbouring task/ }))
  await panel.press({ text: 'Edit' })
  await panel.type({ label: 'Estimated tokens' }, '45000', { replace: true })
  await panel.select({ label: 'Profile' }, 'sonnet-medium')
  await panel.press({ text: 'Save' })
  const sent = calls.find((c) => c.name === 'task.update') as { input: Record<string, unknown> }
  assert.equal(sent.input.estTokens, '45000')
  assert.equal(sent.input.profile, 'sonnet-medium')
})

test('the_assignee_shows_as_a_badge_and_a_missing_one_is_flagged', async () => {
  const assigned = rich({ 'task.get': () => ({ ...detail, assignee: 'agent:swift-expert' }) })
  panel = await mount(panelModule, { host: assigned.host })
  await panel.press({ text: /^t-4 / })
  assert.ok(panel.find({ text: 'agent:swift-expert' }))
  assert.equal(panel.find({ text: /not found/ }), null)
  await panel.unmount()
  const gone = rich({ 'task.get': () => ({ ...detail, assignee: 'agent:gone', assigneeMissing: true }) })
  panel = await mount(panelModule, { host: gone.host })
  await panel.press({ text: /^t-4 / })
  assert.ok(panel.find({ text: /agent:gone is not found/ }))
})

test('the_edit_form_picks_an_assignee_from_the_catalog_and_can_clear_it', async () => {
  const { host, calls } = rich({ 'task.get': () => ({ ...detail, assignee: 'skill:design-review' }) })
  panel = await mount(panelModule, { host })
  await panel.press({ text: /^t-4 / })
  await panel.press({ text: 'Edit' })
  assert.equal(panel.valueOf({ label: 'Assignee' }), 'skill:design-review')
  await panel.select({ label: 'Assignee' }, 'agent:swift-expert')
  await panel.press({ text: 'Save' })
  assert.equal((calls.find((c) => c.name === 'task.update') as { input: Record<string, unknown> }).input.assignee, 'agent:swift-expert')
  await panel.press({ text: 'Edit' })
  await panel.select({ label: 'Assignee' }, 'none')
  await panel.press({ text: 'Save' })
  const last = calls.filter((c) => c.name === 'task.update').at(-1) as { input: Record<string, unknown> }
  assert.equal(last.input.assignee, '')
})
