// Orbit store: markdown+frontmatter files under <primary repo root>/.orbit. No dependencies.
import { execFileSync } from 'node:child_process'
import {
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
const TEMPLATES = new URL('../skills/orbit-project/templates/', import.meta.url)

const oneLine = (v) => String(v ?? '').replace(/\s*\n\s*/g, ' ').trim()

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

export function findPrimaryRoot(cwd) {
  const common = execFileSync(
    'git',
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    { cwd, encoding: 'utf8' }
  ).trim()
  return realpathSync(basename(common) === '.git' ? dirname(common) : common)
}

const itemDir = (root, kind) => join(root, '.orbit', KINDS[kind][0])

// ponytail: mkdir-based lock with spin; fine for a handful of agents, use proper flock if contention grows
function withLock(file, fn) {
  const lock = `${file}.lock`
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

export function newItem(root, kind, title, { plan = '', depends = [] } = {}) {
  const [folder, prefix] = KINDS[kind] ?? (() => { throw new Error(`unknown kind: ${kind}`) })()
  const dir = itemDir(root, kind)
  mkdirSync(dir, { recursive: true })
  const existing = readdirSync(dir)
    .map((f) => Number(new RegExp(`^${prefix}-(\\d+)\\.md$`).exec(f)?.[1] ?? 0))
  for (let n = Math.max(0, ...existing) + 1; ; n++) {
    const id = `${prefix}-${n}`
    const vars = { id, title: oneLine(title), plan, depends: depends.join(', '), date: new Date().toISOString().slice(0, 10) }
    const text = readFileSync(new URL(`${kind}.md`, TEMPLATES), 'utf8').replace(
      /\{\{(\w+)\}\}/g,
      (_, k) => vars[k] ?? ''
    )
    try {
      writeFileSync(join(dir, `${id}.md`), text, { flag: 'wx' })
      return { id, folder }
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
    }
  }
}

function updateTask(root, id, mutate) {
  if (!ID_RE.test(id)) throw new Error(`bad id: ${id}`)
  const file = join(itemDir(root, 'task'), `${id}.md`)
  return withLock(file, () => {
    const { data, body } = parseFrontmatter(readFileSync(file, 'utf8'))
    mutate(data)
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, serialize(data, body))
    renameSync(tmp, file)
    return data
  })
}

export function claim(root, id, { owner, workspace, worktree }) {
  return updateTask(root, id, (data) => {
    if (data.owner && data.owner !== owner) {
      throw new Error(`task ${id} already owned by ${data.owner}`)
    }
    Object.assign(data, { owner, workspace, status: 'doing' }, worktree ? { worktree } : {})
  })
}

export function setStatus(root, id, status, note) {
  if (!STATUSES.includes(status)) {
    throw new Error(`bad status "${status}", use one of: ${STATUSES.join(', ')}`)
  }
  return updateTask(root, id, (data) => {
    data.status = status
    if (note !== undefined) data.note = note
  })
}

export function listTasks(root, { status } = {}) {
  let files
  try {
    files = readdirSync(itemDir(root, 'task')).filter((f) => /^t-\d+\.md$/.test(f))
  } catch {
    return []
  }
  return files
    .map((f) => parseFrontmatter(readFileSync(join(itemDir(root, 'task'), f), 'utf8')).data)
    .filter((t) => !status || t.status === status)
    .sort((a, b) => Number(a.id.slice(2)) - Number(b.id.slice(2)))
}
