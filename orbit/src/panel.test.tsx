import { afterEach, assert, mockHost, mount, test, type TestPanel } from 'orca/testing'
import * as panelModule from './panel'

const LONG = 'A task title that is much longer than the panel can show on one line'
const empty = { todo: [], doing: [], review: [], done: [], blocked: [] }
const board = {
  focus: 'project',
  repos: [
    {
      root: '/repo',
      name: 'repo',
      progress: { done: 0, total: 2, pct: 0 },
      columns: {
        ...empty,
        doing: [{ id: 't-4', title: LONG, status: 'doing', agent: { state: 'working', title: 'Claude' } }],
        review: [{ id: 't-5', title: 'Short one', status: 'review' }]
      }
    }
  ],
  agents: [],
  agentCounts: { total: 0, working: 0, blocked: 0, waiting: 0, done: 0 }
}
const detail = {
  id: 't-4',
  title: LONG,
  status: 'doing',
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
    { root: '/repo', id: 't-4', title: 'Renamed', body: detail.body, status: 'review', baseHash: 'h1', pause: false }
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
