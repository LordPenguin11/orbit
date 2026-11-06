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
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { formatBrief } from './brief.mjs'
import { discoverCatalog, resolveAssignee } from './catalog.mjs'
import { DEFAULT_CONFIG, assess, mergeConfig, suggestMerges, taskRange } from './sizing.mjs'

export const STATUSES = ['todo', 'doing', 'review', 'qa', 'done', 'blocked']
const KINDS = {
  feature: ['features', 'f'],
  task: ['tasks', 't'],
  bug: ['bugs', 'b'],
  subtask: ['subtasks', 's'],
  plan: ['plans', 'p'],
  doc: ['docs', 'd']
}
const WORK_KINDS = ['task', 'bug', 'subtask'] // items with live status: they have shared state
const ARCHIVABLE = ['feature', ...WORK_KINDS]
const KIND_BY_PREFIX = Object.fromEntries(Object.entries(KINDS).map(([kind, [, prefix]]) => [prefix, kind]))
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
  existsSync(stateRoot(cwd)) || worktreePaths(cwd).some((p) => existsSync(join(p, '.orbit')))

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

/** Agents and skills available for this repo. ORBIT_HOME swaps the home directory (tests use it). */
export function catalogFor(cwd) {
  const home = process.env.ORBIT_HOME ?? homedir()
  return discoverCatalog({
    home,
    configDir: process.env.ORBIT_HOME ? join(home, '.claude') : undefined,
    workspaces: worktreePaths(cwd)
  })
}

const assigneeKey = (cwd, input) => (input ? resolveAssignee(catalogFor(cwd), input) : '')

/** A project template (`.orbit/templates/<kind>.md` in any worktree) wins over the built-in one. */
function templateText(cwd, kind) {
  for (const p of worktreePaths(cwd)) {
    const file = join(p, '.orbit', 'templates', `${kind}.md`)
    if (existsSync(file)) return readFileSync(file, 'utf8')
  }
  return readFileSync(new URL(`${kind}.md`, TEMPLATES), 'utf8')
}

function checkRelations(cwd, kind, { feature, parent }) {
  if (kind === 'subtask') {
    if (!parent) throw new Error('a subtask needs a parent (--parent <task or bug id>)')
    if (!definitions(cwd, 'task').has(parent) && !definitions(cwd, 'bug').has(parent)) {
      throw new Error(`unknown parent ${parent} (a parent must be a task or a bug)`)
    }
  }
  if (feature && (kind === 'task' || kind === 'bug') && !definitions(cwd, 'feature').has(feature)) {
    throw new Error(`unknown feature ${feature}`)
  }
}

export function newItem(cwd, kind, title, opts = {}) {
  const [folder] = KINDS[kind] ?? (() => { throw new Error(`unknown kind: ${kind}`) })()
  const { plan = '', depends = [], feature = '', parent = '', severity = '', estTokens = '', profile = '' } = opts
  checkRelations(cwd, kind, { feature, parent })
  const assignee = kind === 'task' || kind === 'bug' ? assigneeKey(cwd, opts.assignee) : ''
  const dir = join(git(cwd, 'rev-parse', '--show-toplevel'), '.orbit', folder)
  mkdirSync(dir, { recursive: true })
  const template = templateText(cwd, kind)
  for (;;) {
    const id = allocateId(cwd, kind)
    const vars = { id, title: oneLine(title), plan, depends: depends.join(', '), feature, parent, severity, estTokens, profile, assignee, date: today() }
    try {
      writeFileSync(join(dir, `${id}.md`), template.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? ''), { flag: 'wx' })
      return { id, folder }
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
    }
  }
}

function definitionOf(cwd, id) {
  if (!/^[tbs]-\d+$/.test(id)) throw new Error(`not a work item id: ${id}`)
  const file = definitions(cwd, KIND_BY_PREFIX[id[0]]).get(id)
  if (!file) throw new Error(`unknown work item: ${id}`)
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

/** Advice only: reaching done without QA, or with open subtasks, is allowed but reported. */
function doneAdvice(cwd, id, previous) {
  const advice = []
  if (KIND_BY_PREFIX[id[0]] !== 'subtask' && previous !== 'qa') {
    advice.push(`${id} went to done without QA (recommended: review -> qa -> done)`)
  }
  const open = listWork(cwd, { kind: 'subtask' }).filter((s) => s.parent === id && s.status !== 'done').length
  if (open > 0) advice.push(`${id} still has ${open} open subtask${open > 1 ? 's' : ''}`)
  return advice.join('; ') || undefined
}

export function setStatus(cwd, id, status, note) {
  if (!STATUSES.includes(status)) {
    throw new Error(`bad status "${status}", use one of: ${STATUSES.join(', ')}`)
  }
  const file = definitionOf(cwd, id)
  const previous = readState(cwd, id).status || parseFrontmatter(readFileSync(file, 'utf8')).data.status || 'todo'
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
  const warning = status === 'done' ? doneAdvice(cwd, id, previous) : undefined
  return warning ? { ...state, warning } : state
}

/** Tasks, bugs and subtasks: definition fields + shared state, tagged with their kind. */
export function listWork(cwd, { status, kind, feature } = {}) {
  return (kind ? [kind] : WORK_KINDS)
    .flatMap((k) =>
      [...definitions(cwd, k)].map(([id, file]) => {
        const merged = { ...parseFrontmatter(readFileSync(file, 'utf8')).data, ...readState(cwd, id) }
        return { ...merged, kind: k, status: merged.status || 'todo' }
      })
    )
    .filter((w) => (!status || w.status === status) && (!feature || w.feature === feature))
    .sort((a, b) => WORK_KINDS.indexOf(a.kind) - WORK_KINDS.indexOf(b.kind) || Number(a.id.slice(2)) - Number(b.id.slice(2)))
}

export function listFeatures(cwd) {
  return [...definitions(cwd, 'feature')]
    .map(([, file]) => parseFrontmatter(readFileSync(file, 'utf8')).data)
    .sort((a, b) => Number(a.id.slice(2)) - Number(b.id.slice(2)))
}

// Archive: a finished item moves to <worktree>/.orbit/archive/<folder>/ (a git rename, so history stays).
// Archived items leave every listing, but their ids still count as done for dependencies and progress.
function archivedFiles(cwd) {
  const found = []
  for (const p of worktreePaths(cwd)) {
    for (const kind of ARCHIVABLE) {
      const [folder, prefix] = KINDS[kind]
      const dir = join(p, '.orbit', 'archive', folder)
      let names
      try {
        names = readdirSync(dir)
      } catch {
        continue
      }
      for (const name of names) {
        const id = new RegExp(`^(${prefix}-\\d+)\\.md$`).exec(name)?.[1]
        if (id) found.push({ id, kind, file: join(dir, name) })
      }
    }
  }
  return found
}

export const archivedIds = (cwd) => new Set(archivedFiles(cwd).map((a) => a.id))

// ponytail: reads every archived file's frontmatter on each call; keep an index if archives reach thousands
export function listArchived(cwd) {
  return archivedFiles(cwd)
    .map(({ id, kind, file }) => ({
      ...parseFrontmatter(readFileSync(file, 'utf8')).data,
      ...(WORK_KINDS.includes(kind) ? readState(cwd, id) : {}),
      id,
      kind,
      status: 'done'
    }))
    .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))
}

/** Ids moved together with `id`: a task takes its subtasks, a feature takes its tasks, bugs and their subtasks. */
function family(cwd, id, work) {
  const subtasksOf = (parent) => work.filter((w) => w.kind === 'subtask' && w.parent === parent).map((w) => w.id)
  const kind = KIND_BY_PREFIX[id[0]]
  if (!ARCHIVABLE.includes(kind)) throw new Error(`cannot archive ${id}: only features, tasks, bugs and subtasks`)
  if (kind === 'subtask') return [id]
  if (kind === 'task' || kind === 'bug') return [...subtasksOf(id), id]
  const children = work.filter((w) => w.feature === id && w.kind !== 'subtask').map((w) => w.id)
  return [...children.flatMap((c) => [...subtasksOf(c), c]), id]
}

export function archiveItem(cwd, id) {
  const work = listWork(cwd)
  const ids = family(cwd, id, work)
  for (const x of ids.filter((x) => x !== id || KIND_BY_PREFIX[id[0]] !== 'feature')) {
    const item = work.find((w) => w.id === x)
    if (!item || item.status !== 'done') {
      throw new Error(`${x} is ${item?.status ?? 'missing'}, only done items can be archived`)
    }
  }
  if (KIND_BY_PREFIX[id[0]] === 'feature' && ids.length === 1) throw new Error(`${id} has no finished work to archive`)
  for (const x of ids) {
    const kind = KIND_BY_PREFIX[x[0]]
    const file = definitions(cwd, kind).get(x)
    const dest = join(dirname(dirname(file)), 'archive', KINDS[kind][0])
    mkdirSync(dest, { recursive: true })
    renameSync(file, join(dest, basename(file)))
  }
  return ids
}

/** Archive every finished feature, task and bug. Whatever cannot move (an open subtask, say) is reported. */
export function archiveDone(cwd) {
  const archived = []
  const skipped = []
  const attempt = (id) => {
    try {
      archived.push(...archiveItem(cwd, id))
    } catch (error) {
      skipped.push({ id, reason: error.message })
    }
  }
  for (const feature of listFeatures(cwd)) {
    const children = listWork(cwd, { feature: feature.id }).filter((w) => w.kind !== 'subtask')
    if (children.length > 0 && children.every((c) => c.status === 'done')) attempt(feature.id)
  }
  for (const item of listWork(cwd, { status: 'done' }).filter((w) => w.kind !== 'subtask')) {
    if (!archived.includes(item.id)) attempt(item.id)
  }
  return { archived, skipped }
}

export function unarchiveItem(cwd, id) {
  const all = archivedFiles(cwd)
  const items = listArchived(cwd)
  const wanted = new Set(family(cwd, id, items))
  const moved = []
  for (const { id: x, kind, file } of all.filter((a) => wanted.has(a.id))) {
    const dest = join(dirname(dirname(dirname(file))), KINDS[kind][0])
    mkdirSync(dest, { recursive: true })
    renameSync(file, join(dest, basename(file)))
    moved.push(x)
  }
  if (moved.length === 0) throw new Error(`${id} is not archived`)
  return moved
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
  return { ...merged, kind: KIND_BY_PREFIX[id[0]], status: merged.status || 'todo', body, hash: sha1(text) }
}

const revisionsDir = (cwd, id) => join(stateRoot(cwd), 'revisions', id)

/**
 * Edit title/body (definition, in git) and status (shared state). `baseHash` is the hash the editor
 * opened; a different current hash means someone else edited meanwhile and nothing is written.
 * The previous definition is kept in revisions/ so agents can diff against it.
 */
export function editTask(cwd, id, { title, body, status, estTokens, profile, assignee, baseHash }) {
  if (status !== undefined && !STATUSES.includes(status)) {
    throw new Error(`bad status "${status}", use one of: ${STATUSES.join(', ')}`)
  }
  if (estTokens !== undefined && estTokens !== '' && !(Number.isInteger(Number(estTokens)) && Number(estTokens) > 0)) {
    throw new Error('estTokens must be a positive whole number')
  }
  if (profile) profileFor(cwd, profile) // throws on an unknown profile
  const assigneeNext = assignee === undefined ? undefined : assigneeKey(cwd, assignee) // throws when unknown
  const file = definitionOf(cwd, id)
  const changed = { title: false, body: false, status: false, fields: false }
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
    const next = { ...data, title: nextTitle }
    for (const [key, value] of [['estTokens', estTokens], ['profile', profile], ['assignee', assigneeNext]]) {
      if (value !== undefined && String(value) !== String(data[key] ?? '')) {
        next[key] = String(value)
        changed.fields = true
      }
    }
    currentStatus = readState(cwd, id).status || data.status || 'todo'
    if (changed.title || changed.body || changed.fields) {
      const dir = revisionsDir(cwd, id)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, `${Date.now()}-${process.hrtime.bigint() % 1000000n}.md`), text, { flag: 'wx' })
      atomicWrite(file, serialize(next, nextBody))
    }
  })
  let warning
  if (status !== undefined && status !== currentStatus) {
    warning = setStatus(cwd, id, status).warning // outside the definition lock: done also rewrites the definition
    changed.status = true
  }
  if (changed.title || changed.body || changed.status || changed.fields) {
    mkdirSync(stateRoot(cwd), { recursive: true })
    appendFileSync(
      join(stateRoot(cwd), 'events.jsonl'),
      `${JSON.stringify({ ts: new Date().toISOString(), id, event: 'edited', changed })}\n`
    )
  }
  return { changed, hash: sha1(readFileSync(file, 'utf8')), warning }
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

/** Compact start-of-session context for one work item (see brief.mjs). */
export function readBrief(cwd, id) {
  const task = readTask(cwd, id)
  const work = listWork(cwd)
  const feature = task.feature ? listFeatures(cwd).find((f) => f.id === task.feature) : null
  const parent = task.parent ? work.find((w) => w.id === task.parent) : null
  const readBody = (item) => (item ? { ...item, body: readTask(cwd, item.id).body } : null)
  return formatBrief({
    task,
    feature: feature ? { ...feature, body: parseFrontmatter(readFileSync(definitions(cwd, 'feature').get(feature.id), 'utf8')).body } : null,
    parent: readBody(parent),
    dependencies: (task.depends ?? []).map((d) => ({ id: d, status: work.find((w) => w.id === d)?.status ?? (archivedIds(cwd).has(d) ? 'done' : 'unknown') })),
    subtasks: work.filter((w) => w.kind === 'subtask' && w.parent === id),
    size: sizeLine(cwd, task)
  })
}

function sizeLine(cwd, task) {
  if (task.kind === 'subtask') return null
  const profile = profileFor(cwd, task.profile)
  const a = assess(task, profile)
  if (!a.ratio) return `unestimated (profile ${profile.name}: ${profile.model}, ${profile.effort})`
  return `~${a.estTokens} tokens = ${Math.round(a.ratio * 100)}% of a ${profile.name} session (${profile.model}, ${profile.effort}); ${a.verdict}`
}

/** `.orbit/config.json` of the first worktree that has one, laid over the default profiles. */
export function readConfig(cwd) {
  for (const p of worktreePaths(cwd)) {
    const file = join(p, '.orbit', 'config.json')
    if (!existsSync(file)) continue
    try {
      return mergeConfig(DEFAULT_CONFIG, JSON.parse(readFileSync(file, 'utf8')))
    } catch (error) {
      throw new Error(`${file}: ${error.message}`)
    }
  }
  return DEFAULT_CONFIG
}

export function profileFor(cwd, name) {
  const { sizing } = readConfig(cwd)
  const key = name || sizing.default
  const profile = sizing.profiles[key]
  if (!profile) throw new Error(`unknown profile ${key} (have: ${Object.keys(sizing.profiles).join(', ')})`)
  return { name: key, ...profile }
}

export function profileTable(cwd) {
  const { sizing } = readConfig(cwd)
  return Object.keys(sizing.profiles).map((name) => ({ ...profileFor(cwd, name), range: taskRange(sizing.profiles[name]) }))
}

/** Every open task and bug against its profile, plus merge proposals for the too-small ones. */
export function sizeReport(cwd) {
  const items = listWork(cwd)
    .filter((w) => w.kind !== 'subtask' && w.status !== 'done')
    .map((w) => {
      const profile = profileFor(cwd, w.profile)
      return { id: w.id, kind: w.kind, title: w.title, feature: w.feature || '', profile: profile.name, ...assess(w, profile), estTokens: w.estTokens }
    })
  const merges = []
  for (const name of new Set(items.map((i) => i.profile))) {
    const small = items.filter((i) => i.profile === name && i.verdict === 'too-small')
    const range = taskRange(profileFor(cwd, name))
    for (const m of suggestMerges(small, range.max)) merges.push({ profile: name, ...m, stillSmall: m.total < range.min })
  }
  return { items, merges }
}

/** A feature's own definition (fields + body); its progress comes from rollupFeature. */
export function readFeature(cwd, id) {
  const file = definitions(cwd, 'feature').get(id)
  if (!file) throw new Error(`unknown feature: ${id}`)
  const { data, body } = parseFrontmatter(readFileSync(file, 'utf8'))
  return { ...data, kind: 'feature', body }
}
