import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatBrief } from './brief.mjs'

const task = {
  id: 't-4', kind: 'task', status: 'doing', title: 'Build form', depends: ['t-2', 't-3'], feature: 'f-1',
  body: '\n## Goal\n\nShip the form.\n\n## Steps\n\n- [ ] one\n'
}
const feature = { id: 'f-1', title: 'Checkout', body: '\n## Goal\n\nUsers can pay.\n\n## Acceptance\n\n- [ ] x\n' }

test('brief_has_a_header_the_feature_goal_dependencies_subtasks_and_the_body', () => {
  const out = formatBrief({
    task,
    feature,
    dependencies: [{ id: 't-2', status: 'done' }, { id: 't-3', status: 'qa' }],
    subtasks: [{ id: 's-1', status: 'done', title: 'Validate' }, { id: 's-2', status: 'todo', title: 'Submit' }]
  })
  assert.match(out, /^t-4 task \[doing\] Build form/)
  assert.match(out, /Feature f-1 Checkout: Users can pay\./)
  assert.match(out, /Depends: t-2 \(done\), t-3 \(qa\)/)
  assert.match(out, /s-1 \[done\] Validate/)
  assert.match(out, /s-2 \[todo\] Submit/)
  assert.match(out, /## Steps/)
})

test('brief_skips_sections_that_do_not_apply', () => {
  const out = formatBrief({ task: { ...task, feature: '', depends: [] }, feature: null, dependencies: [], subtasks: [] })
  assert.doesNotMatch(out, /Feature|Depends|Subtasks/)
  assert.match(out, /Ship the form\./)
})

test('brief_of_a_subtask_names_its_parent', () => {
  const out = formatBrief({
    task: { id: 's-1', kind: 'subtask', status: 'todo', title: 'Validate', parent: 't-4', body: '\n## Do\n\nCheck email.\n' },
    parent: { id: 't-4', title: 'Build form', body: task.body },
    dependencies: [],
    subtasks: []
  })
  assert.match(out, /Parent t-4 Build form: Ship the form\./)
})

test('brief_shows_the_size_line_when_known', () => {
  const out = formatBrief({ task, feature: null, dependencies: [], subtasks: [], size: '~60000 tokens = 30% of a sonnet-medium session' })
  assert.match(out, /Size: ~60000 tokens = 30% of a sonnet-medium session/)
  assert.doesNotMatch(formatBrief({ task, feature: null, dependencies: [], subtasks: [] }), /Size:/)
})

test('brief_shows_the_assignee_when_set', () => {
  assert.match(formatBrief({ task: { ...task, assignee: 'agent:swift-expert' }, feature: null, dependencies: [], subtasks: [] }), /Assignee: agent:swift-expert/)
  assert.doesNotMatch(formatBrief({ task, feature: null, dependencies: [], subtasks: [] }), /Assignee/)
})
