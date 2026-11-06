import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  archiveDone,
  archiveItem,
  archivedIds,
  claim,
  commonDir,
  editTask,
  findPrimaryRoot,
  listArchived,
  listFeatures,
  listWork,
  migrate,
  newItem,
  parseFrontmatter,
  profileFor,
  readBrief,
  readConfig,
  readTask,
  sizeReport,
  setStatus,
  taskDiff,
  unarchiveItem,
  usesOrbit
} from './store.mjs'

function tempRepo() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-')))
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'ignore' })
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init')
  const worktree = (branch) => {
    const path = `${dir}-${branch}`
    git(dir, 'worktree', 'add', '-q', path, '-b', branch)
    return realpathSync(path)
  }
  return { dir, git, worktree }
}
const task = (cwd, title = 'T') => newItem(cwd, 'task', title, { plan: '', depends: [] }).id
const only = (cwd, id) => listWork(cwd).find((t) => t.id === id)

test('parses_frontmatter', () => {
  const { data, body } = parseFrontmatter(
    '---\nid: t-1\ntitle: Fix: colon\nowner:\ndepends: [t-2, t-3]\n---\n\nbody\n'
  )
  assert.deepEqual(data, { id: 't-1', title: 'Fix: colon', owner: '', depends: ['t-2', 't-3'] })
  assert.equal(body, '\nbody\n')
})

test('finds_primary_root_from_linked_worktree', () => {
  const { dir, worktree } = tempRepo()
  assert.equal(findPrimaryRoot(worktree('feat')), dir)
})

test('state_is_shared_across_worktrees_and_survives_branch_switch', () => {
  const { dir, git, worktree } = tempRepo()
  const wtA = worktree('a')
  const wtB = worktree('b')
  const id = task(dir)
  claim(wtA, id, { owner: 'agent-a', workspace: wtA })
  assert.equal(only(wtB, id).owner, 'agent-a')
  assert.equal(only(dir, id).status, 'doing')
  git(dir, 'checkout', '-q', '-b', 'other')
  git(dir, 'checkout', '-q', 'main')
  assert.equal(only(dir, id).owner, 'agent-a')
  const definition = readFileSync(join(dir, '.orbit', 'tasks', `${id}.md`), 'utf8')
  assert.doesNotMatch(definition, /owner|status|workspace/)
})

test('definitions_merge_across_worktrees_and_ids_never_collide', () => {
  const { dir, worktree } = tempRepo()
  const wtA = worktree('a')
  const ids = [task(wtA, 'A1'), task(dir, 'M1'), task(wtA, 'A2'), task(dir, 'M2')]
  assert.equal(new Set(ids).size, 4)
  assert.deepEqual(listWork(dir).map((t) => t.id).sort(), [...ids].sort())
  assert.equal(listWork(wtA).length, 4)
  // after a merge the same definition exists in two worktrees: still one task
  mkdirSync(join(dir, '.orbit', 'tasks'), { recursive: true })
  copyFileSync(join(wtA, '.orbit', 'tasks', `${ids[0]}.md`), join(dir, '.orbit', 'tasks', `${ids[0]}.md`))
  assert.equal(listWork(dir).length, 4)
})

test('claim_conflict_names_the_owner', () => {
  const { dir } = tempRepo()
  const id = task(dir)
  claim(dir, id, { owner: 'claude-1', workspace: '/wt/a', worktree: 'w-a' })
  assert.equal(only(dir, id).worktree, 'w-a')
  assert.throws(() => claim(dir, id, { owner: 'codex-2', workspace: '/wt/b' }), /claude-1/)
})

test('done_is_written_into_the_definition_and_state_wins_on_reopen', () => {
  const { dir, worktree } = tempRepo()
  const wtA = worktree('a')
  const id = task(wtA)
  setStatus(dir, id, 'done')
  const file = readFileSync(join(wtA, '.orbit', 'tasks', `${id}.md`), 'utf8')
  assert.match(file, /^status: done$/m)
  assert.match(file, /^completed: \d{4}-\d{2}-\d{2}$/m)
  setStatus(dir, id, 'doing')
  assert.equal(only(dir, id).status, 'doing')
})

test('status_changes_append_to_the_event_log', () => {
  const { dir } = tempRepo()
  const id = task(dir)
  claim(dir, id, { owner: 'a', workspace: dir })
  setStatus(dir, id, 'review', 'eyes please')
  const lines = readFileSync(join(commonDir(dir), 'orbit', 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
  assert.deepEqual(lines.map((l) => [l.id, l.status]), [[id, 'doing'], [id, 'review']])
  assert.equal(lines[1].note, 'eyes please')
})

test('migrate_moves_legacy_runtime_fields_into_state', () => {
  const { dir } = tempRepo()
  mkdirSync(join(dir, '.orbit', 'tasks'), { recursive: true })
  writeFileSync(
    join(dir, '.orbit', 'tasks', 't-1.md'),
    '---\nid: t-1\ntitle: Old\nstatus: blocked\nowner: pane-9\nworkspace: /w\nworktree: wid\nplan: p-1\ndepends: []\ncreated: 2026-01-01\nnote: why\n---\n\nbody\n'
  )
  assert.equal(migrate(dir), 1)
  const t = only(dir, 't-1')
  assert.deepEqual([t.status, t.owner, t.workspace, t.worktree, t.note], ['blocked', 'pane-9', '/w', 'wid', 'why'])
  const file = readFileSync(join(dir, '.orbit', 'tasks', 't-1.md'), 'utf8')
  assert.doesNotMatch(file, /owner|status|workspace|worktree|note/)
  assert.match(file, /body/)
  assert.equal(migrate(dir), 0)
})

test('new_ids_continue_after_existing_files', () => {
  const { dir } = tempRepo()
  mkdirSync(join(dir, '.orbit', 'tasks'), { recursive: true })
  writeFileSync(join(dir, '.orbit', 'tasks', 't-6.md'), '---\nid: t-6\ntitle: x\n---\n')
  assert.equal(task(dir), 't-7')
})

test('concurrent_writers_keep_both_fields', async () => {
  const { dir } = tempRepo()
  const url = new URL('./store.mjs', import.meta.url).href
  const D = JSON.stringify(dir)
  for (let round = 0; round < 5; round++) {
    const id = task(dir, `Race ${round}`)
    const I = JSON.stringify(id)
    const run = (call) =>
      new Promise((resolve, reject) =>
        execFile(process.execPath, ['-e', `import('${url}').then(m=>{${call}})`], (err) =>
          err ? reject(err) : resolve()
        )
      )
    await Promise.all([
      run(`m.claim(${D},${I},{owner:'agent-a',workspace:'/wt'})`),
      run(`m.setStatus(${D},${I},'doing','note-b')`)
    ])
    const t = only(dir, id)
    assert.equal(t.owner, 'agent-a')
    assert.equal(t.note, 'note-b')
  }
})

test('concurrent_new_items_get_distinct_ids', async () => {
  const { dir, worktree } = tempRepo()
  const wt = worktree('a')
  const url = new URL('./store.mjs', import.meta.url).href
  const run = (cwd) =>
    new Promise((resolve, reject) =>
      execFile(
        process.execPath,
        ['-e', `import('${url}').then(m=>console.log(m.newItem(${JSON.stringify(cwd)},'task','x',{}).id))`],
        (err, out) => (err ? reject(err) : resolve(out.trim()))
      )
    )
  const ids = await Promise.all(Array.from({ length: 16 }, (_, i) => run(i % 2 ? dir : wt)))
  assert.equal(new Set(ids).size, 16)
})

test('rejects_unknown_status', () => {
  const { dir } = tempRepo()
  assert.throws(() => setStatus(dir, task(dir), 'finished'), /status/)
})

test('migrate_fills_fields_missing_from_existing_state_without_overriding_it', () => {
  const { dir } = tempRepo()
  mkdirSync(join(dir, '.orbit', 'tasks'), { recursive: true })
  writeFileSync(
    join(dir, '.orbit', 'tasks', 't-1.md'),
    '---\nid: t-1\ntitle: Half\nstatus: doing\nowner: pane-9\nworkspace: /w\nplan: p-1\ndepends: []\n---\n'
  )
  setStatus(dir, 't-1', 'review', 'newer note') // state now exists with status+note only
  migrate(dir)
  const t = only(dir, 't-1')
  assert.deepEqual([t.status, t.note, t.owner, t.workspace], ['review', 'newer note', 'pane-9', '/w'])
})

test('read_task_returns_fields_body_and_a_content_hash', () => {
  const { dir } = tempRepo()
  const id = task(dir, 'Readable')
  const t = readTask(dir, id)
  assert.equal(t.title, 'Readable')
  assert.equal(t.status, 'todo')
  assert.match(t.body, /## Goal/)
  assert.match(t.hash, /^[0-9a-f]{40}$/)
})

test('edit_task_updates_title_and_body_and_snapshots_the_previous_version', () => {
  const { dir } = tempRepo()
  const id = task(dir, 'Old title')
  const before = readTask(dir, id)
  const r = editTask(dir, id, { title: 'New title', body: '\n## Goal\n\nNew goal\n', baseHash: before.hash })
  assert.deepEqual(r.changed, { title: true, body: true, status: false, fields: false })
  const after = readTask(dir, id)
  assert.equal(after.title, 'New title')
  assert.match(after.body, /New goal/)
  assert.equal(after.hash, r.hash)
  assert.notEqual(after.hash, before.hash)
  assert.match(taskDiff(dir, id), /-title: Old title[\s\S]*\+title: New title/)
})

test('edit_task_rejects_a_stale_base_hash_without_writing', () => {
  const { dir } = tempRepo()
  const id = task(dir, 'Original')
  const opened = readTask(dir, id)
  editTask(dir, id, { title: 'Agent edit', body: opened.body, baseHash: opened.hash })
  assert.throws(
    () => editTask(dir, id, { title: 'Stale edit', body: opened.body, baseHash: opened.hash }),
    (e) => e.code === 'conflict'
  )
  assert.equal(readTask(dir, id).title, 'Agent edit')
})

test('edit_task_status_goes_through_shared_state_and_needs_no_revision', () => {
  const { dir } = tempRepo()
  const id = task(dir)
  const t = readTask(dir, id)
  const r = editTask(dir, id, { title: t.title, body: t.body, status: 'review', baseHash: t.hash })
  assert.deepEqual(r.changed, { title: false, body: false, status: true, fields: false })
  assert.equal(only(dir, id).status, 'review')
  assert.match(taskDiff(dir, id), /no earlier revision/i)
})

test('edit_task_done_status_is_recorded_in_the_definition_too', () => {
  const { dir } = tempRepo()
  const id = task(dir)
  const t = readTask(dir, id)
  editTask(dir, id, { title: t.title, body: t.body, status: 'done', baseHash: t.hash })
  assert.match(readFileSync(join(dir, '.orbit', 'tasks', `${id}.md`), 'utf8'), /^status: done$/m)
})

test('no_op_edit_does_not_create_a_revision', () => {
  const { dir } = tempRepo()
  const id = task(dir)
  const t = readTask(dir, id)
  editTask(dir, id, { title: 'Changed', body: t.body, baseHash: t.hash })
  const t2 = readTask(dir, id)
  const r = editTask(dir, id, { title: 'Changed', body: t2.body, baseHash: t2.hash })
  assert.deepEqual(r.changed, { title: false, body: false, status: false, fields: false })
  assert.equal(readdirSync(join(commonDir(dir), 'orbit', 'revisions', id)).length, 1)
})

const make = (cwd, kind, title, opts = {}) => newItem(cwd, kind, title, opts).id
const body = (cwd, id) => {
  const dir = { f: 'features', t: 'tasks', b: 'bugs', s: 'subtasks' }[id[0]]
  return readFileSync(join(cwd, '.orbit', dir, `${id}.md`), 'utf8')
}

test('each_kind_gets_its_own_prefix_counter_and_template', () => {
  const { dir } = tempRepo()
  const f = make(dir, 'feature', 'Checkout')
  const t = make(dir, 'task', 'Build form', { feature: f })
  const b = make(dir, 'bug', 'Crash on submit', { feature: f, severity: 'high' })
  const s = make(dir, 'subtask', 'Validate email', { parent: t })
  assert.deepEqual([f, t, b, s], ['f-1', 't-1', 'b-1', 's-1'])
  assert.match(body(dir, f), /## Acceptance/)
  assert.match(body(dir, t), /## Read first/)
  assert.match(body(dir, b), /## Symptom[\s\S]*## Regression test/)
  assert.match(body(dir, b), /^severity: high$/m)
  assert.match(body(dir, s), /^parent: t-1$/m)
  assert.doesNotMatch(body(dir, s), /## Read first/, 'a subtask template is minimal')
})

test('relations_are_validated_when_creating_items', () => {
  const { dir } = tempRepo()
  assert.throws(() => make(dir, 'task', 'Orphan', { feature: 'f-9' }), /unknown feature f-9/)
  assert.throws(() => make(dir, 'subtask', 'No parent', { parent: 't-9' }), /unknown parent t-9/)
  assert.throws(() => make(dir, 'subtask', 'No parent at all'), /needs a parent/)
  const t = make(dir, 'task', 'Real')
  const sub = make(dir, 'subtask', 'Child', { parent: t })
  assert.throws(() => make(dir, 'subtask', 'Grandchild', { parent: sub }), /unknown parent s-1|task or a bug/)
  const b = make(dir, 'bug', 'A bug')
  assert.equal(make(dir, 'subtask', 'Bug child', { parent: b }), 's-2')
})

test('list_work_returns_tasks_bugs_and_subtasks_with_their_kind', () => {
  const { dir } = tempRepo()
  const f = make(dir, 'feature', 'F')
  const t = make(dir, 'task', 'T', { feature: f })
  const b = make(dir, 'bug', 'B', { feature: f })
  const s = make(dir, 'subtask', 'S', { parent: t })
  make(dir, 'task', 'Loose')
  assert.deepEqual(listWork(dir).map((w) => [w.id, w.kind]), [['t-1', 'task'], ['t-2', 'task'], ['b-1', 'bug'], ['s-1', 'subtask']])
  assert.deepEqual(listWork(dir, { feature: f }).map((w) => w.id), [t, b])
  assert.deepEqual(listWork(dir, { kind: 'bug' }).map((w) => w.id), [b])
  assert.equal(only(dir, s).parent, t)
})

test('claim_and_status_work_for_bugs_and_subtasks', () => {
  const { dir } = tempRepo()
  const b = make(dir, 'bug', 'B')
  const s = make(dir, 'subtask', 'S', { parent: make(dir, 'task', 'T') })
  claim(dir, b, { owner: 'a', workspace: dir })
  setStatus(dir, s, 'review')
  assert.equal(only(dir, b).status, 'doing')
  assert.equal(only(dir, s).status, 'review')
  assert.throws(() => setStatus(dir, 'f-1', 'doing'), /not a work item|bad task id|unknown/)
})

test('a_project_template_overrides_the_builtin_one', () => {
  const { dir } = tempRepo()
  mkdirSync(join(dir, '.orbit', 'templates'), { recursive: true })
  writeFileSync(join(dir, '.orbit', 'templates', 'task.md'), '---\nid: {{id}}\ntitle: {{title}}\n---\n\nMY CUSTOM TEMPLATE\n')
  assert.match(body(dir, make(dir, 'task', 'Custom')), /MY CUSTOM TEMPLATE/)
  assert.match(body(dir, make(dir, 'bug', 'Built-in')), /## Symptom/)
})

test('qa_is_a_status_between_review_and_done', () => {
  const { dir } = tempRepo()
  const t = make(dir, 'task', 'T')
  setStatus(dir, t, 'qa')
  assert.equal(only(dir, t).status, 'qa')
})

test('done_without_qa_succeeds_but_warns_while_done_after_qa_does_not', () => {
  const { dir } = tempRepo()
  const skipped = make(dir, 'task', 'Skipped QA')
  setStatus(dir, skipped, 'review')
  const r = setStatus(dir, skipped, 'done')
  assert.match(r.warning, /without QA/)
  assert.equal(only(dir, skipped).status, 'done', 'advisory only: the change still happens')

  const checked = make(dir, 'task', 'Checked')
  setStatus(dir, checked, 'qa')
  assert.equal(setStatus(dir, checked, 'done').warning, undefined)

  const bug = make(dir, 'bug', 'Bug')
  assert.match(setStatus(dir, bug, 'done').warning, /without QA/)
})

test('subtasks_are_exempt_from_the_qa_advice', () => {
  const { dir } = tempRepo()
  const sub = make(dir, 'subtask', 'S', { parent: make(dir, 'task', 'T') })
  assert.equal(setStatus(dir, sub, 'done').warning, undefined)
})

test('closing_a_task_with_open_subtasks_warns', () => {
  const { dir } = tempRepo()
  const t = make(dir, 'task', 'T')
  make(dir, 'subtask', 'Open child', { parent: t })
  setStatus(dir, t, 'qa')
  assert.match(setStatus(dir, t, 'done').warning, /1 open subtask/)
})

const archived = (cwd, folder, id) => join(cwd, '.orbit', 'archive', folder, `${id}.md`)

test('archive_moves_a_done_item_out_of_the_listing_and_keeps_its_state', () => {
  const { dir, git } = tempRepo()
  const t = make(dir, 'task', 'Finished')
  claim(dir, t, { owner: 'a', workspace: dir })
  setStatus(dir, t, 'qa')
  setStatus(dir, t, 'done')
  git(dir, 'add', '-A')
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'task done')
  assert.deepEqual(archiveItem(dir, t), [t])
  assert.equal(only(dir, t), undefined)
  assert.match(readFileSync(archived(dir, 'tasks', t), 'utf8'), /^status: done$/m)
  assert.deepEqual([...archivedIds(dir)], [t])
  const [item] = listArchived(dir)
  assert.deepEqual([item.id, item.kind, item.status, item.owner], [t, 'task', 'done', 'a'])
  git(dir, 'add', '-A') // a rename, so git keeps the history
  assert.match(execFileSync('git', ['status', '--short'], { cwd: dir, encoding: 'utf8' }), /^R /m)
})

test('only_done_items_can_be_archived', () => {
  const { dir } = tempRepo()
  const t = make(dir, 'task', 'Not yet')
  setStatus(dir, t, 'review')
  assert.throws(() => archiveItem(dir, t), /only done items/)
  assert.throws(() => archiveItem(dir, 'p-1'), /cannot archive/)
})

test('archiving_a_task_takes_its_done_subtasks_and_refuses_while_one_is_open', () => {
  const { dir } = tempRepo()
  const t = make(dir, 'task', 'T')
  const s1 = make(dir, 'subtask', 'S1', { parent: t })
  const s2 = make(dir, 'subtask', 'S2', { parent: t })
  setStatus(dir, t, 'done')
  setStatus(dir, s1, 'done')
  assert.throws(() => archiveItem(dir, t), new RegExp(`${s2}.*only done items`))
  setStatus(dir, s2, 'done')
  assert.deepEqual(archiveItem(dir, t).sort(), [s1, s2, t].sort())
  assert.deepEqual(listWork(dir), [])
})

test('archiving_a_feature_takes_all_its_done_children', () => {
  const { dir } = tempRepo()
  const f = make(dir, 'feature', 'F')
  const t = make(dir, 'task', 'T', { feature: f })
  const b = make(dir, 'bug', 'B', { feature: f })
  setStatus(dir, t, 'done')
  assert.throws(() => archiveItem(dir, f), new RegExp(`${b}.*only done items`))
  setStatus(dir, b, 'done')
  assert.deepEqual(archiveItem(dir, f).sort(), [b, f, t].sort())
  assert.equal(existsSync(archived(dir, 'features', f)), true)
  assert.deepEqual(listFeatures(dir), [])
})

test('unarchive_brings_an_item_back', () => {
  const { dir } = tempRepo()
  const t = make(dir, 'task', 'Back again')
  setStatus(dir, t, 'done')
  archiveItem(dir, t)
  assert.deepEqual(unarchiveItem(dir, t), [t])
  assert.equal(only(dir, t).status, 'done')
  assert.deepEqual([...archivedIds(dir)], [])
})

test('brief_gathers_the_feature_dependencies_subtasks_and_treats_archived_dependencies_as_done', () => {
  const { dir } = tempRepo()
  const f = make(dir, 'feature', 'Checkout')
  const dep = make(dir, 'task', 'Dependency', { feature: f })
  setStatus(dir, dep, 'done')
  archiveItem(dir, dep)
  const t = make(dir, 'task', 'Build form', { feature: f, depends: [dep, 't-99'] })
  make(dir, 'subtask', 'Validate email', { parent: t })
  const out = readBrief(dir, t)
  assert.match(out, /Feature f-1 Checkout/)
  assert.match(out, new RegExp(`Depends: ${dep} \\(done\\), t-99 \\(unknown\\)`))
  assert.match(out, /s-1 \[todo\] Validate email/)
  assert.match(out, /## Read first/)
})

test('archive_done_takes_finished_features_tasks_and_bugs_and_reports_the_rest', () => {
  const { dir } = tempRepo()
  const f = make(dir, 'feature', 'Finished feature')
  const ft = make(dir, 'task', 'In feature', { feature: f })
  const open = make(dir, 'feature', 'Open feature')
  const ot = make(dir, 'task', 'Unfinished', { feature: open })
  const loose = make(dir, 'task', 'Loose done')
  const bug = make(dir, 'bug', 'Loose bug')
  const blocked = make(dir, 'task', 'Has open subtask')
  make(dir, 'subtask', 'Still open', { parent: blocked })
  for (const id of [ft, loose, bug, blocked]) setStatus(dir, id, 'done')
  const r = archiveDone(dir)
  assert.deepEqual([...r.archived].sort(), [bug, f, ft, loose].sort())
  assert.equal(r.skipped.length, 1)
  assert.match(r.skipped[0].reason, /s-1.*only done items/)
  assert.deepEqual(listWork(dir).map((w) => w.id).sort(), [blocked, ot, 's-1'].sort())
  assert.deepEqual(listFeatures(dir).map((x) => x.id), [open])
})

test('a_repo_with_only_a_feature_counts_as_using_orbit', () => {
  const { dir } = tempRepo()
  make(dir, 'feature', 'Only a feature')
  assert.equal(usesOrbit(dir), true)
})

const configure = (cwd, config) => {
  mkdirSync(join(cwd, '.orbit'), { recursive: true })
  writeFileSync(join(cwd, '.orbit', 'config.json'), JSON.stringify(config))
}

test('config_json_overrides_the_default_profiles', () => {
  const { dir } = tempRepo()
  assert.equal(readConfig(dir).sizing.default, 'sonnet-medium')
  configure(dir, { sizing: { default: 'tiny', profiles: { tiny: { agent: 'claude', model: 'm', effort: 'low', maxSessionTokens: 50_000, fixedOverheadTokens: 5_000, maxOverheadShare: 0.5, maxFill: 0.8 } } } })
  assert.equal(profileFor(dir).name, 'tiny')
  assert.equal(profileFor(dir, 'opus-high').effort, 'high')
  assert.throws(() => profileFor(dir, 'nope'), /unknown profile nope \(have: .*tiny/)
})

test('a_broken_config_json_is_reported_with_its_name', () => {
  const { dir } = tempRepo()
  mkdirSync(join(dir, '.orbit'), { recursive: true })
  writeFileSync(join(dir, '.orbit', 'config.json'), '{ not json')
  assert.throws(() => readConfig(dir), /config\.json/)
})

test('size_report_assesses_tasks_and_bugs_and_proposes_merges_for_small_ones', () => {
  const { dir } = tempRepo()
  configure(dir, { sizing: { default: 'p', profiles: { p: { agent: 'claude', model: 'm', effort: 'e', maxSessionTokens: 100_000, fixedOverheadTokens: 20_000, maxOverheadShare: 0.4, maxFill: 0.6 } } } })
  const f = make(dir, 'feature', 'F')
  const small1 = make(dir, 'task', 'Small one', { feature: f, estTokens: '10000' })
  const small2 = make(dir, 'bug', 'Small two', { feature: f, estTokens: '12000' })
  const ok = make(dir, 'task', 'Right sized', { feature: f, estTokens: '35000' })
  const big = make(dir, 'task', 'Too big', { estTokens: '90000' })
  const unknown = make(dir, 'task', 'No estimate')
  const finished = make(dir, 'task', 'Finished and small', { estTokens: '1000' })
  make(dir, 'subtask', 'Not sized', { parent: ok })
  setStatus(dir, finished, 'done')
  const r = sizeReport(dir)
  assert.deepEqual(r.items.map((i) => [i.id, i.verdict]), [
    [small1, 'too-small'], [ok, 'ok'], [big, 'too-large'], [unknown, 'unestimated'], [small2, 'too-small']
  ])
  // 22000 is still under the 30000 minimum for this profile, so the merge is flagged as not enough
  assert.deepEqual(r.merges, [{ profile: 'p', feature: f, ids: [small1, small2], total: 22_000, stillSmall: true }])
})

test('edit_task_changes_the_size_fields_without_counting_as_a_content_edit', () => {
  const { dir } = tempRepo()
  const id = task(dir, 'Sized')
  const t = readTask(dir, id)
  const r = editTask(dir, id, { estTokens: '45000', profile: 'opus-high', baseHash: t.hash })
  assert.deepEqual(r.changed, { title: false, body: false, status: false, fields: true })
  const after = readTask(dir, id)
  assert.deepEqual([after.estTokens, after.profile], ['45000', 'opus-high'])
  const cleared = editTask(dir, id, { estTokens: '', profile: '', baseHash: after.hash })
  assert.equal(cleared.changed.fields, true)
  assert.deepEqual([readTask(dir, id).estTokens, readTask(dir, id).profile], ['', ''])
})

test('edit_task_rejects_a_bad_estimate_or_an_unknown_profile_without_writing', () => {
  const { dir } = tempRepo()
  const id = task(dir, 'Strict')
  const t = readTask(dir, id)
  assert.throws(() => editTask(dir, id, { estTokens: 'lots', baseHash: t.hash }), /estTokens must be a positive whole number/)
  assert.throws(() => editTask(dir, id, { estTokens: '-5', baseHash: t.hash }), /estTokens/)
  assert.throws(() => editTask(dir, id, { profile: 'nope', baseHash: t.hash }), /unknown profile nope/)
  assert.equal(readTask(dir, id).hash, t.hash, 'nothing was written')
})

// Agents and skills are found under ORBIT_HOME (a fake home), never the machine's real one.
function withCatalog(fn) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-home-')))
  const put = (file, text) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, text) }
  put(join(home, '.claude', 'agents', 'android-expert.md'), '---\nname: android-expert\n---\n')
  put(join(home, '.claude', 'agents', 'swift-expert.md'), '---\nname: swift-expert\n---\n')
  put(join(home, '.claude', 'skills', 'design-review', 'SKILL.md'), '---\nname: design-review\n---\n')
  const before = process.env.ORBIT_HOME
  process.env.ORBIT_HOME = home
  try {
    return fn()
  } finally {
    if (before === undefined) delete process.env.ORBIT_HOME
    else process.env.ORBIT_HOME = before
  }
}

test('tasks_and_bugs_take_an_assignee_resolved_against_the_catalog', () => {
  withCatalog(() => {
    const { dir } = tempRepo()
    const t = make(dir, 'task', 'T', { assignee: 'android-expert' })
    const b = make(dir, 'bug', 'B', { assignee: 'skill:design-review' })
    assert.match(body(dir, t), /^assignee: agent:android-expert$/m)
    assert.equal(only(dir, b).assignee, 'skill:design-review')
    assert.equal(only(dir, make(dir, 'task', 'No assignee')).assignee, '')
  })
})

test('an_unknown_assignee_is_rejected_when_creating_and_when_editing_without_writing', () => {
  withCatalog(() => {
    const { dir } = tempRepo()
    assert.throws(() => make(dir, 'task', 'T', { assignee: 'nobody' }), /unknown assignee "nobody"/)
    assert.deepEqual(listWork(dir), [], 'nothing was created')
    const id = make(dir, 'task', 'Real')
    const t = readTask(dir, id)
    assert.throws(() => editTask(dir, id, { assignee: 'nobody', baseHash: t.hash }), /unknown assignee/)
    assert.equal(readTask(dir, id).hash, t.hash)
  })
})

test('edit_task_sets_and_clears_the_assignee', () => {
  withCatalog(() => {
    const { dir } = tempRepo()
    const id = make(dir, 'task', 'T')
    const r = editTask(dir, id, { assignee: 'swift-expert', baseHash: readTask(dir, id).hash })
    assert.deepEqual(r.changed, { title: false, body: false, status: false, fields: true })
    assert.equal(readTask(dir, id).assignee, 'agent:swift-expert')
    editTask(dir, id, { assignee: '', baseHash: readTask(dir, id).hash })
    assert.equal(readTask(dir, id).assignee, '')
  })
})

test('the_brief_names_the_assignee', () => {
  withCatalog(() => {
    const { dir } = tempRepo()
    const id = make(dir, 'task', 'T', { assignee: 'design-review' })
    assert.match(readBrief(dir, id), /Assignee: skill:design-review/)
  })
})
