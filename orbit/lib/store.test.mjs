import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { claim, findPrimaryRoot, listTasks, newItem, parseFrontmatter, setStatus } from './store.mjs'

function tempRepo() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-')))
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init')
  return { dir, git }
}

test('parses_frontmatter', () => {
  const { data, body } = parseFrontmatter(
    '---\nid: t-1\ntitle: Fix: colon\nowner:\ndepends: [t-2, t-3]\n---\n\nbody\n'
  )
  assert.deepEqual(data, { id: 't-1', title: 'Fix: colon', owner: '', depends: ['t-2', 't-3'] })
  assert.equal(body, '\nbody\n')
})

test('finds_primary_root_from_linked_worktree', () => {
  const { dir, git } = tempRepo()
  const linked = join(dir, '..', `${dir.split('/').pop()}-wt`)
  git('worktree', 'add', '-q', linked, '-b', 'feat')
  assert.equal(findPrimaryRoot(realpathSync(linked)), dir)
})

test('claim_sets_owner_and_workspace', () => {
  const { dir } = tempRepo()
  const { id } = newItem(dir, 'task', 'Do thing', { plan: 'p-1', depends: [] })
  claim(dir, id, { owner: 'claude-1', workspace: '/wt/a' })
  const [task] = listTasks(dir)
  assert.equal(task.status, 'doing')
  assert.equal(task.owner, 'claude-1')
  assert.equal(task.workspace, '/wt/a')
  assert.throws(() => claim(dir, id, { owner: 'codex-2', workspace: '/wt/b' }), /claude-1/)
})

test('concurrent_writers_keep_both_fields', async () => {
  const { dir } = tempRepo()
  const url = new URL('./store.mjs', import.meta.url).href
  const D = JSON.stringify(dir)
  for (let round = 0; round < 5; round++) {
    const { id } = newItem(dir, 'task', `Race ${round}`, { plan: '', depends: [] })
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
    const task = listTasks(dir).find((t) => t.id === id)
    assert.equal(task.owner, 'agent-a')
    assert.equal(task.note, 'note-b')
  }
})

test('new_ids_do_not_collide', () => {
  const { dir } = tempRepo()
  const a = newItem(dir, 'task', 'A', { plan: '', depends: [] })
  const b = newItem(dir, 'task', 'B', { plan: '', depends: [] })
  assert.notEqual(a.id, b.id)
  assert.equal(listTasks(dir).length, 2)
})

test('rejects_unknown_status', () => {
  const { dir } = tempRepo()
  const { id } = newItem(dir, 'task', 'X', { plan: '', depends: [] })
  assert.throws(() => setStatus(dir, id, 'finished'), /status/)
})
