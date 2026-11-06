import assert from 'node:assert/strict'
import { test } from 'node:test'
import { appendReminder, decideTool, workspacePathOf } from './guard.mjs'

const task = (status, extra = {}) => ({ id: 't-1', status, owner: 'pane-1', ...extra })
const edit = { tool: 'Edit', input: { file_path: '/repo/src/a.ts' }, workspaceId: 'w1', workspacePath: '/repo' }
const run = (over = {}) => decideTool({ mode: 'block', tasks: [task('todo')], ...edit, ...over })

test('allows_when_repo_has_no_orbit_tasks', () => {
  assert.equal(run({ tasks: [] }), null)
})

test('denies_edit_without_claimed_task_and_names_the_fix', () => {
  const r = run()
  assert.match(r.deny, /task claim/)
  assert.match(r.deny, /guard/i)
})

test('allows_when_task_doing_in_this_workspace_by_id_or_path', () => {
  assert.equal(run({ tasks: [task('doing', { worktree: 'w1' })] }), null)
  assert.equal(run({ tasks: [task('doing', { workspace: '/repo' })] }), null)
  assert.equal(run({ tasks: [task('review', { worktree: 'w1' })] }), null)
})

test('task_claimed_in_another_workspace_does_not_count', () => {
  assert.ok(run({ tasks: [task('doing', { worktree: 'w2', workspace: '/other' })] }))
})

test('allows_orbit_folder_and_non_mutating_tools', () => {
  assert.equal(run({ input: { file_path: '/repo/.orbit/plans/p-1.md' } }), null)
  assert.equal(run({ tool: 'Read' }), null)
  assert.equal(run({ tool: 'Bash', input: { command: 'rm -rf x' } }), null)
})

test('off_mode_and_unknown_workspace_never_deny', () => {
  assert.equal(run({ mode: 'off' }), null)
  assert.equal(run({ workspaceId: null, workspacePath: null }), null)
})

test('append_reminder_is_idempotent', () => {
  const once = appendReminder('do the thing')
  assert.match(once, /orbit-project/)
  assert.equal(appendReminder(once), once)
})

test('workspace_path_comes_from_uuid_double_colon_path_ids', () => {
  assert.equal(workspacePathOf('54bc-1::/Users/me/repo'), '/Users/me/repo')
  assert.equal(workspacePathOf('identity:wt2:local:abc'), null)
  assert.equal(workspacePathOf(null), null)
})
