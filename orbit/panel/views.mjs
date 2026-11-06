// Panel views: pure functions from `state` to HTML strings.
import { escapeHtml as esc, renderMarkdown } from './markdown.mjs'
import { COLUMNS, isFeature, state, top } from './state.mjs'

const svg = (paths) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`
const ICON = {
  back: svg('<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>'),
  left: svg('<path d="m15 18-6-6 6-6"/>'),
  right: svg('<path d="m9 18 6-6-6-6"/>'),
  edit: svg(
    '<path d="M21.2 6.8a1 1 0 0 0-4-4L3.8 16.2a2 2 0 0 0-.5.8l-1.3 4.4a.5.5 0 0 0 .6.6l4.4-1.3a2 2 0 0 0 .8-.5z"/><path d="m15 5 4 4"/>'
  ),
  play: svg('<polygon points="6 3 20 12 6 21 6 3"/>'),
  close: svg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
  warn: svg(
    '<path d="m21.7 18-8-14a2 2 0 0 0-3.5 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>'
  ),
  refresh: svg(
    '<path d="M3 12a9 9 0 0 1 9-9 9.8 9.8 0 0 1 6.7 2.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.8 9.8 0 0 1-6.7-2.7L3 16"/><path d="M8 16H3v5"/>'
  )
}

const percent = (ratio) => `${Math.round(ratio * 100)}%`

function relativeTime(at) {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (seconds < 60) {
    return 'just now'
  }
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)}m ago`
  }
  if (seconds < 86400) {
    return `${Math.floor(seconds / 3600)}h ago`
  }
  return `${Math.floor(seconds / 86400)}d ago`
}

const chip = (text, tone = '', { plain = false, dot = false, pulse = false } = {}) =>
  `<span class="chip${tone ? ` t-${tone}` : ''}${plain ? ' plain' : ''}">${dot ? `<i class="dot${pulse ? ' pulse' : ''}"></i>` : ''}${esc(text)}</span>`

const button = (label, action, { variant = '', icon = '', data = '', disabled = false } = {}) =>
  `<button class="btn ${variant}" data-action="${action}" ${data}${disabled ? ' disabled' : ''}>${icon ? ICON[icon] : ''}${esc(label)}</button>`

const iconButton = (label, action, icon, { data = '', disabled = false } = {}) =>
  `<button class="btn icon ghost" data-action="${action}" aria-label="${esc(label)}" title="${esc(label)}" ${data}${disabled ? ' disabled' : ''}>${ICON[icon]}</button>`

const skeleton = (label) =>
  `<div class="skeleton" role="status" aria-label="${esc(label)}"><i></i><i></i><i></i></div>`

const plural = (n, word) => `${n} ${word}${n > 1 ? 's' : ''}`
const isCollapsed = (status, items) =>
  state.collapsed[status] ?? (items.length === 0 || status === 'done')
const waitsChip = (task) =>
  task.waitingOn?.length ? chip(`waits ${task.waitingOn.join(', ')}`, 'warn', { plain: true }) : ''
const agentChip = (task, withState) =>
  task.agent
    ? chip(
        withState
          ? `${task.agent.title ?? 'agent'} ${task.agent.state}`
          : (task.agent.title ?? 'agent'),
        'agent',
        { plain: true, dot: true, pulse: task.agent.state === 'working' }
      )
    : ''
const archiveAllButton = (repo) =>
  button('Archive all done', 'archive-done', {
    data: `data-root="${esc(repo.root)}"`,
    disabled: state.busy
  })

function topbar(open, task, actions = '') {
  return `<div class="topbar">${iconButton('Back', 'back', 'back')}${crumbs(open, task)}${actions ? `<div class="actions">${actions}</div>` : ''}</div>`
}
const loadingView = (open) =>
  `${topbar(open, null)}<div class="scroll">${flash()}${state.notice ? '' : skeleton('Loading')}</div>`

const stateBox = (title, body) =>
  `<div class="state"><strong>${esc(title)}</strong><span class="muted">${body}</span></div>`

function flash() {
  const n = state.notice
  if (!n) {
    return ''
  }
  const reloadButton = state.stale ? button('Reload latest', 'reload', { icon: 'refresh' }) : ''
  return `<div class="flash"><div class="callout t-${n.tone}" role="status">${ICON.warn}<div class="body"><span>${esc(n.text)}</span>${reloadButton}</div>${iconButton('Dismiss', 'dismiss', 'close')}</div></div>`
}

function taskCard(task, root) {
  const who = task.assignee
    ? `<span class="who" title="${esc(task.assignee)}">@${esc(task.assignee)}</span>`
    : ''
  return `<button class="card" data-action="open" data-root="${esc(root)}" data-id="${esc(task.id)}">
    <span class="card-id"><span>${esc(task.id)}</span>${waitsChip(task)}</span>
    <span class="card-title" title="${esc(task.title)}">${esc(task.title)}</span>
    <span class="card-foot">${chip(task.kind, task.kind === 'bug' ? 'bad' : '')}${who}${agentChip(task, true)}</span>
  </button>`
}

function column([status, title], repo) {
  const items = repo.columns[status]
  const collapsed = isCollapsed(status, items)
  const archiveAll = status === 'done' && items.length > 0 ? archiveAllButton(repo) : ''
  const body =
    items.length > 0
      ? items.map((t) => taskCard(t, repo.root)).join('')
      : '<p class="empty">No tasks</p>'
  return `<section class="col t-${status}${collapsed ? ' collapsed' : ''}" data-status="${status}">
    <button class="col-head" data-action="toggle-col" data-status="${status}" aria-expanded="${!collapsed}">
      <i class="dot"></i><span class="col-title">${esc(title)}</span><span class="count">${items.length}</span>
    </button>
    <div class="col-body" data-status="${status}">${body}${archiveAll}</div>
  </section>`
}

function taskRow(task, root) {
  const bug = task.kind === 'bug' ? chip('bug', 'bad') : ''
  return `<button class="lrow" data-action="open" data-root="${esc(root)}" data-id="${esc(task.id)}">
    <span class="id">${esc(task.id)}</span><span class="t" title="${esc(task.title)}">${esc(task.title)}</span>${waitsChip(task)}${bug}${agentChip(task, false)}
  </button>`
}

function listSection([status, title], repo) {
  const items = repo.columns[status]
  const collapsed = isCollapsed(status, items)
  const archiveAll =
    status === 'done' && items.length > 0 && !collapsed
      ? `<div class="lfoot">${archiveAllButton(repo)}</div>`
      : ''
  return `<section class="lsec t-${status}">
    <button class="lsec-head" data-action="toggle-col" data-status="${status}" aria-expanded="${!collapsed}">${ICON.right}<i class="dot"></i><span class="col-title">${esc(title)}</span><span class="count">${items.length}</span></button>
    ${collapsed ? '' : items.map((t) => taskRow(t, repo.root)).join('')}${archiveAll}
  </section>`
}

function featureRows(repo) {
  if (repo.features.length === 0) {
    return '<p class="empty">No features yet.</p>'
  }
  return `<div class="rows">${repo.features
    .map((f) => {
      const bugs = f.openBugs > 0 ? chip(plural(f.openBugs, 'bug'), 'bad') : ''
      return `<button class="row" data-action="open" data-root="${esc(repo.root)}" data-id="${esc(f.id)}">
        <span class="id">${esc(f.id)}</span><span class="grow title">${esc(f.title)}</span>${bugs}${chip(f.status, f.status, { dot: true })}<span class="meta">${f.done}/${f.total}</span>
      </button>`
    })
    .join('')}</div>`
}

function agentRows(agents) {
  if (agents.length === 0) {
    return '<p class="empty">No agent activity seen since Orca started.</p>'
  }
  const tone = { working: 'agent', waiting: 'warn', blocked: 'bad', done: 'ok' }
  return `<div class="rows">${agents
    .map(
      (a) => `<div class="row">
        <div class="grow"><div class="title">${esc(a.title ?? a.paneKey)}</div><div class="sub">${esc(a.taskId ? `${a.repo} · ${a.taskId}` : 'no claimed task')}</div></div>
        ${chip(a.state, tone[a.state], { dot: true, pulse: a.state === 'working' })}<span class="meta">${relativeTime(a.receivedAt)}</span>
      </div>`
    )
    .join('')}</div>`
}

function boardHeader(data, repo) {
  const working = data.agentCounts.working
  const tabs = [
    ['board', 'Board'],
    ['features', 'Features'],
    ['agents', 'Agents']
  ]
    .map(([id, label]) => {
      const count =
        id === 'agents' && working > 0 ? ` <span class="chip t-agent plain">${working}</span>` : ''
      return `<button role="tab" data-action="tab" data-tab="${id}" aria-selected="${state.tab === id}">${label}${count}</button>`
    })
    .join('')
  const repos =
    data.repos.length > 1
      ? `<div class="repos">${data.repos.map((r) => `<button data-action="repo" data-root="${esc(r.root)}" aria-pressed="${r.root === repo.root}">${esc(r.name)}</button>`).join('')}</div>`
      : ''
  const ambiguous =
    data.focus === 'ambiguous'
      ? '<span class="muted hint">Could not tell which project is focused; showing the repos that may match.</span>'
      : ''
  const { done, total, pct } = repo.progress
  return `<header class="head">${ambiguous}${repos}
    <div class="repo-row"><span class="repo-name">${esc(repo.name)}</span><span class="muted">${done}/${total} done${repo.archivedCount > 0 ? ` · ${repo.archivedCount} archived` : ''}</span></div>
    <div class="seg" role="tablist" aria-label="Orbit views">${tabs}</div>
    <div class="bar t-ok" role="progressbar" aria-label="${esc(repo.name)} progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><i style="width:${pct}%"></i></div>
  </header>`
}

function boardView() {
  const data = state.board
  if (!data) {
    if (!state.failure) {
      return skeleton('Loading the board')
    }
    return `<div class="pad"><div class="callout t-bad">${ICON.warn}<div class="body"><span class="title">Could not load the board</span><span>${esc(state.failure)}</span>${button('Retry', 'retry', { icon: 'refresh' })}</div></div></div>`
  }
  if (data.focus === 'noFocus') {
    return stateBox('No project focused', 'Open a project to see its board.')
  }
  const repo = data.repos.find((r) => r.root === state.repo) ?? data.repos[0]
  if (data.focus === 'none' || !repo) {
    return stateBox(
      'This project does not use Orbit yet',
      'Ask an agent to use the orbit-project skill and run <code>orbit init</code>.'
    )
  }

  const header = boardHeader(data, repo)

  if (state.tab === 'board') {
    const layoutSwitch = ['columns', 'list']
      .map(
        (l) =>
          `<button data-action="layout" data-layout="${l}" aria-pressed="${state.layout === l}">${l === 'columns' ? 'Columns' : 'List'}</button>`
      )
      .join('')
    const arrows =
      state.layout === 'columns'
        ? `<span class="arrows">${iconButton('Scroll columns left', 'scroll-cols', 'left', { data: 'data-dir="-1"' })}${iconButton('Scroll columns right', 'scroll-cols', 'right', { data: 'data-dir="1"' })}</span>`
        : ''
    const bar = `<div class="cols-bar"><span class="layout-switch" role="group" aria-label="Board layout">${layoutSwitch}</span>${arrows}</div>`
    if (state.layout === 'list') {
      return `${header}${flash()}${bar}<div class="scroll"><div class="list">${COLUMNS.map((c) => listSection(c, repo)).join('')}</div></div>`
    }
    return `${header}${flash()}${bar}
      <div class="cols" tabindex="0" role="region" aria-label="Board columns">${COLUMNS.map((c) => column(c, repo)).join('')}</div>`
  }
  const content = state.tab === 'features' ? featureRows(repo) : agentRows(data.agents)
  return `${header}<div class="scroll">${flash()}<div class="pad">${content}</div></div>`
}

function crumbs(open, task) {
  const parent = task?.parent ?? task?.feature
  const link = parent
    ? `<button data-action="open" data-root="${esc(open.root)}" data-id="${esc(parent)}">${esc(parent)}</button><span>/</span>`
    : ''
  return `<div class="crumbs">${link}<span class="here">${esc(open.id)}</span></div>`
}

function sizeMeter(task) {
  const size = task.size
  if (!size) {
    return ''
  }
  if (size.ratio === null) {
    return `<div class="meter"><span class="note">Not sized yet (profile ${esc(size.profile)}). Add an estimate in Edit.</span></div>`
  }
  const ok = size.verdict === 'ok'
  const pct = Math.min(100, Math.round(size.ratio * 100))
  const advice = !ok && size.advice ? `<span class="note warn">${esc(size.advice)}</span>` : ''
  return `<div class="meter">
    <div class="line"><span>Session usage</span>${chip(size.verdict, ok ? 'ok' : 'warn')}</div>
    <div class="bar ${ok ? 't-doing' : 't-warn'}" role="progressbar" aria-label="Share of a session" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><i style="width:${pct}%"></i></div>
    <span class="note">~${size.estTokens} tokens · ${percent(size.ratio)} of a ${esc(size.profile)} session (${esc(size.model)}, ${esc(size.effort)})</span>${advice}
  </div>`
}

const childRows = (items, root, label) =>
  `<div class="rows" role="list" aria-label="${label}">${items
    .map(
      (
        c
      ) => `<button class="row" role="listitem" data-action="open" data-root="${esc(root)}" data-id="${esc(c.id)}">
        ${chip(c.status, c.status, { dot: true })}<span class="id">${esc(c.id)}</span><span class="grow title">${esc(c.title)}</span>${c.kind === 'bug' ? chip('bug', 'bad') : ''}
      </button>`
    )
    .join('')}</div>`

function detailView(open) {
  const task = state.detail
  if (!task) {
    return loadingView(open)
  }
  const canRun = task.kind !== 'subtask' && task.status === 'todo'
  const actions = [
    canRun ? button('Run', 'run', { variant: 'primary', icon: 'play', disabled: state.busy }) : '',
    task.status === 'done' ? button('Archive', 'archive', { disabled: state.busy }) : '',
    button('Edit', 'edit', { variant: canRun ? '' : 'primary', icon: 'edit' })
  ].join('')
  const chips = [
    chip(task.id, '', { plain: true }),
    chip(task.kind, task.kind === 'bug' ? 'bad' : ''),
    chip(task.status, task.status, { dot: true }),
    task.severity ? chip(task.severity, 'warn') : '',
    ...task.working.map((a) =>
      chip(`${a.title} working`, 'agent', { plain: true, dot: true, pulse: true })
    )
  ].join('')
  const facts = [
    task.plan && ['Plan', task.plan],
    task.created && ['Created', task.created],
    task.completed && ['Done', task.completed],
    task.depends.length > 0 && ['Depends on', task.depends.join(', ')],
    task.assignee && ['Assignee', task.assignee]
  ].filter(Boolean)
  const kv =
    facts.length > 0
      ? `<dl class="kv">${facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>`
      : ''
  const missing = task.assigneeMissing
    ? `<div class="callout t-warn">${ICON.warn}<div class="body"><span>${esc(task.assignee)} is not found in this workspace; pick another assignee in Edit.</span></div></div>`
    : ''
  const note = task.note
    ? `<div class="callout neutral"><div class="body"><span>${esc(task.note)}</span></div></div>`
    : ''
  const doneSubtasks = task.subtasks.filter((s) => s.status === 'done').length
  const subtasks =
    task.subtasks.length > 0
      ? `<section><div class="section-head"><h3>Subtasks ${doneSubtasks}/${task.subtasks.length}</h3></div>${childRows(task.subtasks, open.root, 'Subtasks')}</section>`
      : ''
  return `${topbar(open, task, actions)}
    <div class="scroll">${flash()}
      <div class="titleblock"><h1 class="title">${esc(task.title)}</h1><div class="chips">${chips}</div></div>
      ${kv}${sizeMeter(task)}
      <div class="pad">${missing}${note}<div class="md">${renderMarkdown(task.body)}</div>${subtasks}</div>
    </div>`
}

const field = (label, control) =>
  `<label class="field"><span>${esc(label)}</span>${control}</label>`
const options = (items, current) =>
  items
    .map(
      ([value, label]) =>
        `<option value="${esc(value)}"${value === current ? ' selected' : ''}>${esc(label)}</option>`
    )
    .join('')

function editView(open) {
  const task = state.detail
  const form = state.draft
  const full = task.kind !== 'subtask'
  const assignees = [
    ['', 'Unassigned'],
    ...(form.assignee && !task.assignees.some((a) => a.key === form.assignee)
      ? [[form.assignee, `${form.assignee} (not found)`]]
      : []),
    ...task.assignees.map((a) => [a.key, `${a.key} (${a.source})`])
  ]
  const interrupt =
    task.working.length + task.notInterruptible.length > 0
      ? `<label class="check"><input type="checkbox" data-field="pause"${form.pause ? ' checked' : ''}><span>Interrupt agents working on this task and ask them to re-check<span class="help">Working: ${esc(task.working.map((a) => a.title).join(', ') || 'none')}. Agents waiting for you are never interrupted.</span></span></label>`
      : ''
  return `<div class="topbar"><div class="crumbs"><span>EDIT TASK</span><span>/</span><span class="here">${esc(open.id)}</span></div>
      <div class="actions">${button('Cancel', 'reload', { variant: 'ghost', disabled: state.busy })}${button(state.busy ? 'Saving…' : 'Save', 'save', { variant: 'primary', disabled: state.busy || !form.title.trim() })}</div></div>
    <div class="scroll">${flash()}
      <div class="form">
        ${field('Title', `<input data-field="title" value="${esc(form.title)}">`)}
        ${field('Status', `<select data-field="status">${options(COLUMNS, form.status)}</select>`)}
        ${full ? `<div class="pair">${field('Estimated tokens', `<input data-field="estTokens" inputmode="numeric" value="${esc(form.estTokens)}">`)}${field('Profile', `<select data-field="profile">${options([['', 'Default'], ...task.profiles.map((p) => [p, p])], form.profile)}</select>`)}</div>` : ''}
        ${full ? field('Assignee', `<select data-field="assignee">${options(assignees, form.assignee)}</select>`) : ''}
        ${field('Description (markdown)', `<textarea data-field="body" rows="14">${esc(form.body)}</textarea>`)}
        ${interrupt}
      </div>
    </div>`
}

function featureView(open) {
  const feature = state.feature
  if (!feature) {
    return loadingView(open)
  }
  const archive =
    feature.status === 'done' ? button('Archive', 'archive', { disabled: state.busy }) : ''
  const children =
    feature.children.length > 0
      ? `<section><div class="section-head"><h3>Tasks and bugs</h3></div>${childRows(feature.children, open.root, 'Tasks and bugs')}</section>`
      : `<p class="muted">No tasks or bugs yet. Create them with --feature ${esc(feature.id)}.</p>`
  return `${topbar(open, null, archive)}
    <div class="scroll">${flash()}
      <div class="titleblock"><h1 class="title">${esc(feature.title)}</h1>
        <div class="chips">${chip(feature.id, '', { plain: true })}${chip(feature.status, feature.status, { dot: true })}${feature.openBugs > 0 ? chip(plural(feature.openBugs, 'open bug'), 'bad') : ''}</div>
        <div class="bar t-ok" role="progressbar" aria-label="Feature progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${feature.pct}"><i style="width:${feature.pct}%"></i></div>
        <span class="muted mono">${feature.done}/${feature.total} done</span>
      </div>
      <div class="pad">${children}<div class="md">${renderMarkdown(feature.body)}</div></div>
    </div>`
}

export function currentView() {
  const open = top()
  if (!open) {
    return boardView()
  }
  if (isFeature(open.id)) {
    return featureView(open)
  }
  return state.editing && state.detail ? editView(open) : detailView(open)
}
