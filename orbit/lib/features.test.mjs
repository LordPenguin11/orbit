import assert from 'node:assert/strict'
import { test } from 'node:test'
import { rollupFeature } from './features.mjs'

const f = { id: 'f-1', title: 'Checkout' }
const w = (id, kind, status, extra = {}) => ({ id, kind, status, feature: 'f-1', ...extra })

test('counts_and_percent_cover_tasks_and_bugs_only', () => {
  const r = rollupFeature(f, [
    w('t-1', 'task', 'done'),
    w('t-2', 'task', 'doing'),
    w('b-1', 'bug', 'todo'),
    w('s-1', 'subtask', 'done', { feature: undefined, parent: 't-2' }),
    w('t-9', 'task', 'done', { feature: 'f-2' })
  ])
  assert.deepEqual([r.total, r.done, r.pct], [3, 1, 33])
  assert.deepEqual([r.subtasks.total, r.subtasks.done], [1, 1])
  assert.equal(r.openBugs, 1)
})

test('status_is_derived_from_the_children', () => {
  const status = (items) => rollupFeature(f, items).status
  assert.equal(status([]), 'todo')
  assert.equal(status([w('t-1', 'task', 'todo')]), 'todo')
  assert.equal(status([w('t-1', 'task', 'doing'), w('t-2', 'task', 'todo')]), 'doing')
  assert.equal(status([w('t-1', 'task', 'done'), w('t-2', 'task', 'todo')]), 'doing')
  assert.equal(status([w('t-1', 'task', 'done'), w('t-2', 'task', 'done')]), 'done')
  assert.equal(status([w('t-1', 'task', 'blocked'), w('b-1', 'bug', 'blocked')]), 'blocked')
})

test('archived_children_still_count_as_done', () => {
  const r = rollupFeature(f, [w('t-2', 'task', 'doing')], [w('t-1', 'task', 'done'), w('b-1', 'bug', 'done')])
  assert.deepEqual([r.total, r.done, r.pct, r.status, r.openBugs], [3, 2, 67, 'doing', 0])
})
