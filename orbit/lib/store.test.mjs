import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  claim,
  commonDir,
  findPrimaryRoot,
  listTasks,
  migrate,
  newItem,
  parseFrontmatter,
  setStatus
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
const only = (cwd, id) => listTasks(cwd).find((t) => t.id === id)

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
  assert.deepEqual(listTasks(dir).map((t) => t.id).sort(), [...ids].sort())
  assert.equal(listTasks(wtA).length, 4)
  // after a merge the same definition exists in two worktrees: still one task
  mkdirSync(join(dir, '.orbit', 'tasks'), { recursive: true })
  copyFileSync(join(wtA, '.orbit', 'tasks', `${ids[0]}.md`), join(dir, '.orbit', 'tasks', `${ids[0]}.md`))
  assert.equal(listTasks(dir).length, 4)
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
