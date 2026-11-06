// Orbit panel: data, actions, rendering and events. Talks to worker/main.mjs only through
// plugin.request; see src/protocol.ts for the request shapes.
import { COLUMN_GAP, isFeature, LAYOUT_KEY, message, state, top } from './state.mjs'
import { currentView } from './views.mjs'

const { plugin } = window.orca

// ---------- data ----------

let loadSeq = 0

// A response only lands if nothing newer was requested or navigated to meanwhile. Both return whether
// anything changed, so an event that brings identical data does not rebuild the view (and drop focus).
async function refresh({ draw = true } = {}) {
  let changed = false
  try {
    const next = await plugin.request('board.get', {})
    const key = JSON.stringify(next)
    changed = key !== state.boardKey || state.failure !== null
    state.boardKey = key
    state.board = next
    state.failure = null
    const open = top()
    if (open && !state.editing && !next.repos.some((r) => r.root === open.root)) {
      state.stack = []
      resetDetail()
      changed = true
    }
  } catch (error) {
    changed = state.failure !== message(error)
    state.failure = message(error)
  }
  if (draw && changed) {
    softRender()
  }
  return changed
}

async function load({ draw = true } = {}) {
  const open = top()
  if (!open) {
    return false
  }
  const seq = ++loadSeq
  let changed = false
  try {
    const item = await plugin.request(isFeature(open.id) ? 'feature.get' : 'task.get', open)
    if (seq !== loadSeq) {
      return false
    }
    const key = JSON.stringify(item)
    changed = key !== state.itemKey
    state.itemKey = key
    state.feature = isFeature(open.id) ? item : null
    state.detail = isFeature(open.id) ? null : item
  } catch (error) {
    if (seq !== loadSeq) {
      return false
    }
    // A failed reload must not hide the result of the action that triggered it.
    if (!state.notice) {
      state.notice = { tone: 'bad', text: message(error) }
      changed = true
    }
  }
  if (draw && changed) {
    softRender()
  }
  return changed
}

// board.changed and workspace.changed often arrive together: one round of requests, one render.
let syncing = null
let syncAgain = false
function syncSoon() {
  if (syncing) {
    syncAgain = true
    return syncing
  }
  syncing = Promise.all([refresh({ draw: false }), state.editing ? false : load({ draw: false })])
    .then((changes) => {
      if (changes.some(Boolean)) {
        softRender()
      }
    })
    .finally(() => {
      syncing = null
      if (syncAgain) {
        syncAgain = false
        void syncSoon()
      }
    })
  return syncing
}

function clearNotice() {
  state.notice = null
  state.stale = false
}

function resetDetail() {
  loadSeq++
  state.itemKey = ''
  state.detail = null
  state.feature = null
  state.editing = false
  clearNotice()
}

async function openItem(root, id) {
  state.stack = [...state.stack, { root, id }]
  resetDetail()
  render()
  await load()
}

async function back() {
  state.stack = state.stack.slice(0, -1)
  resetDetail()
  render()
  await (top() ? load() : refresh())
}

function startEdit() {
  const task = state.detail
  if (!task) {
    return
  }
  state.draft = {
    title: task.title,
    body: task.body,
    status: task.status,
    estTokens: task.estTokens ?? '',
    profile: task.profile ?? '',
    assignee: task.assignee ?? '',
    pause: true
  }
  clearNotice()
  state.editing = true
  render()
}

async function reload() {
  clearNotice()
  state.editing = false
  render()
  await load()
}

async function save() {
  const open = top()
  const task = state.detail
  if (!open || !task) {
    return
  }
  const form = state.draft
  state.busy = true
  render()
  try {
    const result = await plugin.request('task.update', {
      ...open,
      title: form.title,
      body: form.body,
      status: form.status,
      ...(task.kind === 'subtask'
        ? {}
        : { estTokens: form.estTokens, profile: form.profile, assignee: form.assignee }),
      baseHash: task.hash,
      pause: form.pause
    })
    const parts = ['Saved.']
    if (result.paused.length > 0) {
      parts.push(`Interrupted ${result.paused.join(', ')} and asked to re-check.`)
    }
    for (const s of result.skipped) {
      parts.push(`${s.title} not interrupted: ${s.reason}.`)
    }
    if (result.warning) {
      parts.push(`Note: ${result.warning}.`)
    }
    state.notice = {
      tone: result.skipped.length > 0 || result.warning ? 'warn' : 'ok',
      text: parts.join(' ')
    }
    state.editing = false
    state.busy = false
    render()
    await load()
  } catch (error) {
    const text = message(error)
    state.stale = /changed since/.test(text)
    state.notice = {
      tone: 'bad',
      text: state.stale ? 'This task changed while you were editing.' : text
    }
    state.busy = false
    render()
  }
}

// `run` returns the success notice: a string, or { tone, text } when it is not plain success.
async function act(label, run) {
  state.busy = true
  render()
  try {
    const done = await run()
    state.notice = typeof done === 'string' ? { tone: 'ok', text: done } : done
    await load()
    void refresh()
  } catch (error) {
    state.notice = { tone: 'bad', text: `${label} failed: ${message(error)}` }
  } finally {
    state.busy = false
    render()
  }
}

const runTask = (open) =>
  act('Run', async () => {
    const r = await plugin.request('task.run', open)
    return `Started an agent on ${open.id} in ${r.worktree.split(/[\\/]/).at(-1)} with profile ${r.profile}.`
  })

// Pops the archived item without loading it; act() then loads whatever is now on top.
const archiveOne = (open) =>
  act('Archive', async () => {
    const r = await plugin.request('task.archive', open)
    state.stack = state.stack.slice(0, -1)
    resetDetail()
    return `Archived ${r.archived.join(', ')}.`
  })

const archiveAllDone = (root) =>
  act('Archive', async () => {
    const r = await plugin.request('archive.done', { root })
    return {
      tone: r.skipped.length > 0 ? 'warn' : 'ok',
      text: `Archived ${r.archived.length}.${r.skipped.map((s) => ` ${s.id}: ${s.reason}.`).join('')}`
    }
  })

// ---------- rendering ----------

const app = document.getElementById('app')

function captureScroll() {
  const cols = app.querySelector('.cols')
  const bodies = Object.fromEntries(
    [...app.querySelectorAll('.col-body')].map((el) => [el.dataset.status, el.scrollTop])
  )
  return { cols: cols?.scrollLeft ?? 0, bodies, main: app.querySelector('.scroll')?.scrollTop ?? 0 }
}

function restoreScroll(saved) {
  const cols = app.querySelector('.cols')
  if (cols) {
    cols.style.scrollBehavior = 'auto'
    cols.scrollLeft = saved.cols
    cols.style.scrollBehavior = ''
  }
  for (const el of app.querySelectorAll('.col-body')) {
    el.scrollTop = saved.bodies[el.dataset.status] ?? 0
  }
  const main = app.querySelector('.scroll')
  if (main) {
    main.scrollTop = saved.main
  }
}

function syncArrows() {
  const cols = app.querySelector('.cols')
  if (!cols) {
    return
  }
  const left = app.querySelector('[data-dir="-1"]')
  const right = app.querySelector('[data-dir="1"]')
  if (left) {
    left.disabled = cols.scrollLeft <= 1
  }
  if (right) {
    right.disabled = cols.scrollLeft + cols.clientWidth >= cols.scrollWidth - 1
  }
}

// Scroll carries over only while the same view stays on screen (same tab, item and edit mode).
let lastViewKey = ''
const viewKey = () => `${top()?.id ?? `board:${state.tab}:${state.layout}`}:${state.editing}`

function render() {
  const key = viewKey()
  const saved = key === lastViewKey ? captureScroll() : null
  lastViewKey = key
  app.innerHTML = currentView()
  if (saved) {
    restoreScroll(saved)
  }
  const cols = app.querySelector('.cols')
  cols?.addEventListener('scroll', syncArrows, { passive: true })
  cols?.addEventListener('scrollend', syncArrows)
  syncArrows()
}

// Background updates never rebuild the edit form under the person's cursor.
function softRender() {
  if (!state.editing) {
    render()
  }
}

function scrollColumns(direction) {
  const cols = app.querySelector('.cols')
  if (!cols) {
    return
  }
  const lefts = [...cols.querySelectorAll('.col')].map((c) => c.offsetLeft - COLUMN_GAP)
  const x = cols.scrollLeft
  const target = direction > 0 ? lefts.find((l) => l > x + 4) : lefts.findLast((l) => l < x - 4)
  cols.scrollTo({ left: target ?? (direction > 0 ? cols.scrollWidth : 0) })
}

// ---------- events ----------

const actions = {
  tab: (el) => {
    state.tab = el.dataset.tab
    render()
  },
  layout: (el) => {
    state.layout = el.dataset.layout
    try {
      localStorage.setItem(LAYOUT_KEY, state.layout)
    } catch {
      // storage blocked: the choice lasts until the panel closes
    }
    render()
  },
  repo: (el) => {
    state.repo = el.dataset.root
    render()
  },
  open: (el) => openItem(el.dataset.root, el.dataset.id),
  back: () => back(),
  edit: () => startEdit(),
  reload: () => reload(),
  save: () => save(),
  run: () => runTask(top()),
  archive: () => archiveOne(top()),
  'archive-done': (el) => archiveAllDone(el.dataset.root),
  retry: () => refresh(),
  dismiss: () => {
    clearNotice()
    render()
  },
  'toggle-col': (el) => {
    const status = el.dataset.status
    state.collapsed[status] = el.getAttribute('aria-expanded') === 'true'
    render()
  },
  'scroll-cols': (el) => scrollColumns(Number(el.dataset.dir))
}

document.addEventListener('click', (event) => {
  const el = event.target.closest('[data-action]')
  if (el && !el.disabled) {
    void actions[el.dataset.action]?.(el)
  }
})

document.addEventListener('input', (event) => {
  const key = event.target.dataset?.field
  if (key && state.draft) {
    state.draft[key] = event.target.type === 'checkbox' ? event.target.checked : event.target.value
  }
  if (key === 'title') {
    app
      .querySelector('[data-action="save"]')
      ?.toggleAttribute('disabled', state.busy || !state.draft.title.trim())
  }
})

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || event.defaultPrevented || state.busy || state.editing || !top()) {
    return
  }
  if (event.target.closest?.('select, input, textarea')) {
    return
  }
  void back()
})

window.addEventListener('resize', syncArrows)

plugin.on('board.changed', () => void syncSoon())
window.orca.on('workspace.changed', () => void syncSoon())
setInterval(() => {
  if (state.tab === 'agents' && !top() && !document.hidden) {
    softRender()
  }
}, 30000)

render()
void refresh()
