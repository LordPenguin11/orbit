// Orbit store. No dependencies. Two homes with different lifetimes:
//  - definitions (plans, docs, tasks) are markdown in <worktree>/.orbit/, tracked by git and merged across worktrees;
//  - runtime state (status, owner, ...) is JSON in <git-common-dir>/orbit/state, shared by every worktree,
//    never checked out, so a branch switch cannot touch it. Status changes also append to events.jsonl.
// Every function takes `cwd`: any path inside the repo or one of its worktrees.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, join } from 'node:path'

export const STATUSES = ['todo', 'doing', 'review', 'done', 'blocked']
const KINDS = { task: ['tasks', 't'], plan: ['plans', 'p'], doc: ['docs', 'd'] }
const ID_RE = /^[tpd]-\d+$/
const RUNTIME_FIELDS = ['status', 'owner', 'workspace', 'worktree', 'note']
const TEMPLATES = new URL('../skills/orbit-project/templates/', import.meta.url)

const oneLine = (v) => String(v ?? '').replace(/\s*\n\s*/g, ' ').trim()
const today = () => new Date().toISOString().slice(0, 10)
const sha1 = (text) => createHash('sha1').update(text).digest('hex')
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

export function parseFrontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text)
  if (!m) return { data: {}, body: text }
  const data = {}
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':')
    if (i < 1) continue
    const raw = line.slice(i + 1).trim()
    data[line.slice(0, i).trim()] = /^\[.*\]$/.test(raw)
      ? raw.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean)
      : raw
  }
  return { data, body: m[2] }
}

export function serialize(data, body) {
  const lines = Object.entries(data).map(([k, v]) =>
    `${k}: ${Array.isArray(v) ? `[${v.map(oneLine).join(', ')}]` : oneLine(v)}`.trimEnd()
  )
  return `---\n${lines.join('\n')}\n---\n${body}`
}

export const commonDir = (cwd) =>
  realpathSync(git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'))

export function findPrimaryRoot(cwd) {
  const common = commonDir(cwd)
  return basename(common) === '.git' ? dirname(common) : common
}

/** The main checkout first, then linked worktrees, as git lists them. */
export function worktreePaths(cwd) {
  return git(cwd, 'worktree', 'list', '--porcelain')
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice('worktree '.length))
    .filter((p) => existsSync(p))
}

export const stateRoot = (cwd) => join(commonDir(cwd), 'orbit')

export const usesOrbit = (cwd) =>
  existsSync(stateRoot(cwd)) || worktreePaths(cwd).some((p) => existsSync(join(p, '.orbit', 'tasks')))

// ponytail: mkdir-based lock with spin; fine for a handful of agents, use proper flock if contention grows
function withLock(file, fn) {
  const lock = `${file}.lock`
  mkdirSync(dirname(file), { recursive: true })
  const start = Date.now()
  for (;;) {
    try {
      mkdirSync(lock)
      break
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      try {
        if (Date.now() - statSync(lock).mtimeMs > 10_000) rmSync(lock, { recursive: true })
      } catch {}
      if (Date.now() - start > 5_000) throw new Error(`lock timeout: ${file}`)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
    }
  }
  try {
    return fn()
  } finally {
    rmSync(lock, { recursive: true, force: true })
  }
}

function atomicWrite(file, text) {
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, text)
  renameSync(tmp, file)
}

/** id -> definition file, across worktrees; the first worktree holding an id wins (main checkout first). */
function definitions(cwd, kind) {
  const [folder, prefix] = KINDS[kind]
  const re = new RegExp(`^(${prefix}-\\d+)\\.md$`)
  const found = new Map()
  for (const p of worktreePaths(cwd)) {
    let files
    try {
      files = readdirSync(join(p, '.orbit', folder))
    } catch {
      continue
    }
    for (const f of files) {
      const id = re.exec(f)?.[1]
      if (id && !found.has(id)) found.set(id, join(p, '.orbit', folder, f))
    }
  }
  return found
}

const stateFile = (cwd, id) => join(stateRoot(cwd), 'state', `${id}.json`)

function readState(cwd, id) {
  try {
    return JSON.parse(readFileSync(stateFile(cwd, id), 'utf8'))
  } catch {
    return {}
  }
}

function updateState(cwd, id, mutate) {
  const file = stateFile(cwd, id)
  return withLock(file, () => {
    const state = readState(cwd, id)
    mutate(state)
    state.updated = new Date().toISOString()
    atomicWrite(file, JSON.stringify(state, null, 2))
    appendFileSync(
      join(stateRoot(cwd), 'events.jsonl'),
      `${JSON.stringify({ ts: state.updated, id, status: state.status, owner: state.owner, note: state.note })}\n`
    )
    return state
  })
}

function allocateId(cwd, kind) {
  const prefix = KINDS[kind][1]
  const countersFile = join(stateRoot(cwd), 'counters.json')
  return withLock(countersFile, () => {
    let counters = {}
    try {
      counters = JSON.parse(readFileSync(countersFile, 'utf8'))
    } catch {}
    const onDisk = [...definitions(cwd, kind).keys()].map((id) => Number(id.slice(2)))
    const n = Math.max(counters[kind] ?? 0, ...onDisk) + 1
    atomicWrite(countersFile, JSON.stringify({ ...counters, [kind]: n }))
    return `${prefix}-${n}`
  })
}

export function newItem(cwd, kind, title, { plan = '', depends = [] } = {}) {
  const [folder] = KINDS[kind] ?? (() => { throw new Error(`unknown kind: ${kind}`) })()
  const dir = join(git(cwd, 'rev-parse', '--show-toplevel'), '.orbit', folder)
  mkdirSync(dir, { recursive: true })
  const template = readFileSync(new URL(`${kind}.md`, TEMPLATES), 'utf8')
  for (;;) {
    const id = allocateId(cwd, kind)
    const vars = { id, title: oneLine(title), plan, depends: depends.join(', '), date: today() }
    try {
      writeFileSync(join(dir, `${id}.md`), template.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? ''), { flag: 'wx' })
      return { id, folder }
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
    }
  }
}

function definitionOf(cwd, id) {
  if (!/^t-\d+$/.test(id)) throw new Error(`bad task id: ${id}`)
  const file = definitions(cwd, 'task').get(id)
  if (!file) throw new Error(`unknown task: ${id}`)
  return file
}

export function claim(cwd, id, { owner, workspace, worktree }) {
  const def = parseFrontmatter(readFileSync(definitionOf(cwd, id), 'utf8')).data
  return updateState(cwd, id, (state) => {
    const current = state.owner ?? def.owner
    if (current && current !== owner) throw new Error(`task ${id} already owned by ${current}`)
    Object.assign(state, { owner, workspace, status: 'doing' }, worktree ? { worktree } : {})
  })
}

export function setStatus(cwd, id, status, note) {
  if (!STATUSES.includes(status)) {
    throw new Error(`bad status "${status}", use one of: ${STATUSES.join(', ')}`)
  }
  const file = definitionOf(cwd, id)
  const state = updateState(cwd, id, (s) => {
    s.status = status
    if (note !== undefined) s.note = note
  })
  if (status === 'done') {
    // The one runtime fact git records: done is final enough to travel with the branch.
    withLock(file, () => {
      const { data, body } = parseFrontmatter(readFileSync(file, 'utf8'))
      atomicWrite(file, serialize({ ...data, status: 'done', completed: data.completed || today() }, body))
    })
  }
  return state
}

export function listTasks(cwd, { status } = {}) {
  return [...definitions(cwd, 'task')]
    .map(([id, file]) => {
      const def = parseFrontmatter(readFileSync(file, 'utf8')).data
      const merged = { ...def, ...readState(cwd, id) }
      return { ...merged, status: merged.status || 'todo' }
    })
    .filter((t) => !status || t.status === status)
    .sort((a, b) => Number(a.id.slice(2)) - Number(b.id.slice(2)))
}

// Old format: runtime fields lived in the definition. New format keeps only `status: done` + `completed`.
const isLegacy = (d) =>
  ['owner', 'workspace', 'worktree', 'note'].some((k) => k in d) ||
  (d.status !== undefined && !(d.status === 'done' && d.completed))

/** Move runtime fields of old-format task files into shared state. Returns how many files changed. */
export function migrate(cwd) {
  let changed = 0
  for (const [id, file] of definitions(cwd, 'task')) {
    const { data, body } = parseFrontmatter(readFileSync(file, 'utf8'))
    if (!isLegacy(data)) continue
    const runtime = Object.fromEntries(RUNTIME_FIELDS.filter((k) => data[k]).map((k) => [k, data[k]]))
    if (Object.keys(runtime).length > 0) {
      // State may already exist (written after the old store was replaced): fill gaps, never override it.
      updateState(cwd, id, (s) => Object.assign(s, { ...runtime, ...s }))
    }
    const rest = Object.fromEntries(Object.entries(data).filter(([k]) => !RUNTIME_FIELDS.includes(k)))
    if (data.status === 'done') {
      Object.assign(rest, { status: 'done', completed: data.completed || statSync(file).mtime.toISOString().slice(0, 10) })
    }
    atomicWrite(file, serialize(rest, body))
    changed++
  }
  return changed
}

/** One task for the detail view: definition fields + shared state + body, and a hash to detect concurrent edits. */
export function readTask(cwd, id) {
  const text = readFileSync(definitionOf(cwd, id), 'utf8')
  const { data, body } = parseFrontmatter(text)
  const merged = { ...data, ...readState(cwd, id) }
  return { ...merged, status: merged.status || 'todo', body, hash: sha1(text) }
}

const revisionsDir = (cwd, id) => join(stateRoot(cwd), 'revisions', id)

/**
 * Edit title/body (definition, in git) and status (shared state). `baseHash` is the hash the editor
 * opened; a different current hash means someone else edited meanwhile and nothing is written.
 * The previous definition is kept in revisions/ so agents can diff against it.
 */
export function editTask(cwd, id, { title, body, status, baseHash }) {
  if (status !== undefined && !STATUSES.includes(status)) {
    throw new Error(`bad status "${status}", use one of: ${STATUSES.join(', ')}`)
  }
  const file = definitionOf(cwd, id)
  const changed = { title: false, body: false, status: false }
  let currentStatus
  withLock(file, () => {
    const text = readFileSync(file, 'utf8')
    if (sha1(text) !== baseHash) {
      throw Object.assign(new Error(`task ${id} changed since you opened it`), { code: 'conflict' })
    }
    const { data, body: oldBody } = parseFrontmatter(text)
    const nextTitle = title === undefined ? data.title : oneLine(title)
    const nextBody = body === undefined ? oldBody : body
    changed.title = nextTitle !== data.title
    changed.body = nextBody !== oldBody
    currentStatus = readState(cwd, id).status || data.status || 'todo'
    if (changed.title || changed.body) {
      const dir = revisionsDir(cwd, id)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, `${Date.now()}-${process.hrtime.bigint() % 1000000n}.md`), text, { flag: 'wx' })
      atomicWrite(file, serialize({ ...data, title: nextTitle }, nextBody))
    }
  })
  if (status !== undefined && status !== currentStatus) {
    setStatus(cwd, id, status) // outside the definition lock: done also rewrites the definition
    changed.status = true
  }
  if (changed.title || changed.body || changed.status) {
    mkdirSync(stateRoot(cwd), { recursive: true })
    appendFileSync(
      join(stateRoot(cwd), 'events.jsonl'),
      `${JSON.stringify({ ts: new Date().toISOString(), id, event: 'edited', changed })}\n`
    )
  }
  return { changed, hash: sha1(readFileSync(file, 'utf8')) }
}

/** Unified diff between the newest earlier revision of a task definition and the current one. */
export function taskDiff(cwd, id) {
  const file = definitionOf(cwd, id)
  let revisions
  try {
    revisions = readdirSync(revisionsDir(cwd, id)).sort()
  } catch {
    revisions = []
  }
  if (revisions.length === 0) return `${id}: no earlier revision`
  try {
    execFileSync('git', ['diff', '--no-index', '--no-color', '--', join(revisionsDir(cwd, id), revisions.at(-1)), file], { encoding: 'utf8' })
    return `${id}: no difference from the latest revision`
  } catch (e) {
    if (e.status === 1) return e.stdout // git diff exits 1 when files differ
    throw e
  }
}
