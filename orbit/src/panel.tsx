// No build step: Orca compiles this TSX when it loads.
import {
  atom,
  Badge,
  Button,
  Callout,
  Checkbox,
  Collapsible,
  EmptyState,
  Heading,
  Input,
  List,
  ListItem,
  Markdown,
  on,
  plugin,
  Progress,
  read,
  RelativeTime,
  Row,
  Select,
  set,
  Stack,
  Text,
  Textarea,
  type PanelContext
} from 'orca'
import type { AgentState, BoardData, FeatureDetail, Status, TaskDetail } from './protocol'

type Ref = { root: string; id: string }
type Flash = { tone: 'success' | 'warning' | 'danger' | 'neutral'; text: string }

const board = atom<BoardData | null>(null)
const failure = atom<string | null>(null)

// Detail views: a stack of opened items (feature ids start with "f-"), so Back returns where you came from.
const stack = atom<Ref[]>([])
const detail = atom<TaskDetail | null>(null)
const featureDetail = atom<FeatureDetail | null>(null)
const editing = atom(false)
const stale = atom(false)
const busy = atom(false)
const notice = atom<Flash | null>(null)
const draft = atom({ title: '', body: '', status: 'todo' as Status, estTokens: '', profile: '', assignee: '', pause: true })

const COLUMNS: { status: Status; title: string; open: boolean }[] = [
  { status: 'doing', title: 'Doing', open: true },
  { status: 'review', title: 'Review', open: true },
  { status: 'qa', title: 'QA', open: true },
  { status: 'blocked', title: 'Blocked', open: true },
  { status: 'todo', title: 'Todo', open: false },
  { status: 'done', title: 'Done', open: false }
]
// A Select option cannot carry an empty value, so "use the project default" travels as this word.
const DEFAULT_PROFILE = 'default'
const UNASSIGNED = 'none'
const STATUS_OPTIONS = COLUMNS.map((c) => ({ value: c.status, label: c.title }))
const AGENT_TONE = { working: 'accent', waiting: 'warning', blocked: 'danger', done: 'success' } as const

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))
const short = (title: string) => (title.length > 42 ? `${title.slice(0, 41)}…` : title)
const isFeature = (id: string) => id.startsWith('f-')
const top = (): Ref | null => read(stack).at(-1) ?? null
const percent = (ratio: number) => `${Math.round(ratio * 100)}%`

async function refresh(): Promise<void> {
  try {
    set(board, await plugin.request('board.get', {}))
    set(failure, null)
  } catch (error) {
    set(failure, message(error))
  }
}

async function load(): Promise<void> {
  const open = top()
  if (!open) return
  try {
    if (isFeature(open.id)) {
      set(featureDetail, await plugin.request('feature.get', open))
      set(detail, null)
    } else {
      set(detail, await plugin.request('task.get', open))
      set(featureDetail, null)
    }
  } catch (error) {
    set(notice, { tone: 'danger', text: message(error) })
  }
}

async function openItem(root: string, id: string): Promise<void> {
  set(stack, [...read(stack), { root, id }])
  set(notice, null)
  set(editing, false)
  set(stale, false)
  set(detail, null)
  set(featureDetail, null)
  await load()
}

async function back(): Promise<void> {
  set(stack, read(stack).slice(0, -1))
  set(editing, false)
  set(notice, null)
  set(detail, null)
  set(featureDetail, null)
  if (top()) await load()
  else await refresh()
}

function startEdit(): void {
  const task = read(detail)
  if (!task) return
  set(draft, { title: task.title, body: task.body, status: task.status, estTokens: task.estTokens ?? '', profile: task.profile ?? '', assignee: task.assignee ?? '', pause: true })
  set(notice, null)
  set(stale, false)
  set(editing, true)
}

async function reload(): Promise<void> {
  set(notice, null)
  set(stale, false)
  set(editing, false)
  await load()
}

async function save(): Promise<void> {
  const open = top()
  const task = read(detail)
  if (!open || !task) return
  const form = read(draft)
  set(busy, true)
  try {
    const result = await plugin.request('task.update', {
      ...open,
      title: form.title,
      body: form.body,
      status: form.status,
      ...(task.kind === 'subtask' ? {} : { estTokens: form.estTokens, profile: form.profile, assignee: form.assignee }),
      baseHash: task.hash,
      pause: form.pause
    })
    const parts = ['Saved.']
    if (result.paused.length > 0) parts.push(`Interrupted ${result.paused.join(', ')} and asked to re-check.`)
    for (const s of result.skipped) parts.push(`${s.title} not interrupted: ${s.reason}.`)
    if (result.warning) parts.push(`Note: ${result.warning}.`)
    set(notice, { tone: result.skipped.length > 0 || result.warning ? 'warning' : 'success', text: parts.join(' ') })
    set(editing, false)
    await load()
  } catch (error) {
    const text = message(error)
    const conflict = /changed since/.test(text)
    set(stale, conflict)
    set(notice, { tone: 'danger', text: conflict ? 'This task changed while you were editing. Reload to see the latest.' : text })
  } finally {
    set(busy, false)
  }
}

async function act(label: string, run: () => Promise<string>): Promise<void> {
  set(busy, true)
  try {
    set(notice, { tone: 'success', text: await run() })
    await load()
    void refresh()
  } catch (error) {
    set(notice, { tone: 'danger', text: `${label} failed: ${message(error)}` })
  } finally {
    set(busy, false)
  }
}

const runTask = (open: Ref) =>
  act('Run', async () => {
    const r = await plugin.request('task.run', open)
    return `Started an agent on ${open.id} with profile ${r.profile}.`
  })

const archiveOne = (open: Ref) =>
  act('Archive', async () => {
    const r = await plugin.request('task.archive', open)
    await back()
    return `Archived ${r.archived.join(', ')}.`
  })

async function archiveAllDone(root: string): Promise<void> {
  set(busy, true)
  try {
    const r = await plugin.request('archive.done', { root })
    set(notice, { tone: r.skipped.length > 0 ? 'warning' : 'success', text: `Archived ${r.archived.length}.${r.skipped.map((s) => ` ${s.id}: ${s.reason}.`).join('')}` })
    await refresh()
  } catch (error) {
    set(notice, { tone: 'danger', text: `Archive failed: ${message(error)}` })
  } finally {
    set(busy, false)
  }
}

export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(
    plugin.on('board.changed', () => {
      void refresh()
      if (top() && !read(editing)) void load()
    }),
    on('workspace.changed', () => void refresh())
  )
  void refresh()
}

function AgentBadge({ state }: { state: AgentState }) {
  return <Badge tone={AGENT_TONE[state]}>{state}</Badge>
}

const flashView = () => {
  const flash = read(notice)
  return flash ? <Callout tone={flash.tone}>{flash.text}</Callout> : null
}

function SizeBlock({ task }: { task: TaskDetail }) {
  const size = task.size
  if (!size) return null
  if (size.ratio === null) {
    return <Text muted size="xs">Not sized yet (profile {size.profile}). Add an estimate in Edit.</Text>
  }
  const verdictTone = size.verdict === 'ok' ? 'success' : 'warning'
  return (
    <Stack gap="xs">
      <Row justify="between">
        <Text size="xs" muted>
          ~{size.estTokens} tokens · {percent(size.ratio)} of a {size.profile} session ({size.model}, {size.effort})
        </Text>
        <Badge tone={verdictTone}>{size.verdict}</Badge>
      </Row>
      <Progress label="Share of a session" labelHidden value={Math.min(100, Math.round(size.ratio * 100))} />
      {size.advice && size.verdict !== 'ok' ? <Text size="xs" tone="warning">{size.advice}</Text> : null}
    </Stack>
  )
}

function TaskDetailView({ open }: { open: Ref }) {
  const task = read(detail)
  const isEditing = read(editing)
  const form = read(draft)
  const busyNow = read(busy)
  const header = (
    <Row justify="between">
      <Button variant="ghost" onPress={() => void back()}>Back</Button>
      {task && !isEditing ? (
        <Row gap="xs">
          {task.kind !== 'subtask' && task.status === 'todo' ? (
            <Button icon="play" disabled={busyNow} onPress={() => void runTask(open)}>Run</Button>
          ) : null}
          {task.status === 'done' ? <Button variant="outline" disabled={busyNow} onPress={() => void archiveOne(open)}>Archive</Button> : null}
          <Button icon="edit" onPress={startEdit}>Edit</Button>
        </Row>
      ) : null}
    </Row>
  )
  if (!task) return <Stack gap="md">{header}{flashView() ?? <Text muted>Loading…</Text>}</Stack>

  if (isEditing) {
    return (
      <Stack gap="md">
        {header}
        {flashView()}
        {read(stale) ? <Button onPress={() => void reload()}>Reload latest</Button> : null}
        <Input label="Title" value={form.title} onChange={(title) => set(draft, { ...form, title })} />
        <Select label="Status" value={form.status} options={STATUS_OPTIONS} onChange={(status) => set(draft, { ...form, status: status as Status })} />
        {task.kind !== 'subtask' ? (
          <Row gap="xs">
            <Input label="Estimated tokens" value={form.estTokens} onChange={(estTokens) => set(draft, { ...form, estTokens })} />
            <Select
              label="Profile"
              value={form.profile || DEFAULT_PROFILE}
              options={[{ value: DEFAULT_PROFILE, label: 'Default' }, ...task.profiles.map((p) => ({ value: p, label: p }))]}
              onChange={(profile) => set(draft, { ...form, profile: profile === DEFAULT_PROFILE ? '' : profile })}
            />
          </Row>
        ) : null}
        {task.kind !== 'subtask' ? (
          <Select
            label="Assignee"
            value={form.assignee || UNASSIGNED}
            options={[
              { value: UNASSIGNED, label: 'Unassigned' },
              ...(form.assignee && !task.assignees.some((a) => a.key === form.assignee) ? [{ value: form.assignee, label: `${form.assignee} (not found)` }] : []),
              ...task.assignees.map((a) => ({ value: a.key, label: `${a.key} (${a.source})` }))
            ]}
            onChange={(assignee) => set(draft, { ...form, assignee: assignee === UNASSIGNED ? '' : assignee })}
          />
        ) : null}
        <Textarea label="Description (markdown)" rows={14} value={form.body} onChange={(body) => set(draft, { ...form, body })} />
        {task.working.length + task.notInterruptible.length > 0 ? (
          <Checkbox
            label="Interrupt agents working on this task and ask them to re-check"
            description={`Working: ${task.working.map((a) => a.title).join(', ') || 'none'}. Agents waiting for you are never interrupted.`}
            checked={form.pause}
            onChange={(pause) => set(draft, { ...form, pause })}
          />
        ) : null}
        <Row gap="xs">
          <Button disabled={busyNow || !form.title.trim()} onPress={() => void save()}>{busyNow ? 'Saving…' : 'Save'}</Button>
          <Button variant="ghost" disabled={busyNow} onPress={() => void reload()}>Cancel</Button>
        </Row>
      </Stack>
    )
  }

  const meta = [
    task.plan ? `Plan ${task.plan}` : '',
    task.created ? `created ${task.created}` : '',
    task.completed ? `done ${task.completed}` : '',
    task.depends.length > 0 ? `depends on ${task.depends.join(', ')}` : ''
  ].filter(Boolean).join(' · ')
  return (
    <Stack gap="md">
      {header}
      {flashView()}
      <Heading level={2}>{task.id} {task.title}</Heading>
      <Row gap="xs">
        <Badge tone={task.kind === 'bug' ? 'danger' : 'neutral'}>{task.kind}</Badge>
        <Badge tone={task.status === 'done' ? 'success' : task.status === 'blocked' ? 'danger' : 'accent'}>{task.status}</Badge>
        {task.severity ? <Badge tone="warning">{task.severity}</Badge> : null}
        {task.assignee ? <Badge tone={task.assigneeMissing ? 'warning' : 'neutral'}>{task.assignee}</Badge> : null}
        {task.working.map((a) => <Badge key={a.title} tone="accent">{a.title} working</Badge>)}
      </Row>
      {task.feature ? (
        <Button variant="ghost" onPress={() => void openItem(open.root, task.feature as string)}>Feature {task.feature} {task.featureTitle ?? ''}</Button>
      ) : null}
      {task.parent ? <Button variant="ghost" onPress={() => void openItem(open.root, task.parent as string)}>Parent {task.parent}</Button> : null}
      {meta ? <Text muted size="xs">{meta}</Text> : null}
      {task.assigneeMissing ? <Text size="xs" tone="warning">{task.assignee} is not found in this workspace; pick another assignee in Edit.</Text> : null}
      <SizeBlock task={task} />
      {task.note ? <Callout tone="neutral">{task.note}</Callout> : null}
      {task.subtasks.length > 0 ? (
        <List label="Subtasks">
          {task.subtasks.map((s) => (
            <ListItem key={s.id} title={`${s.id} ${short(s.title)}`} description={s.status} onPress={() => void openItem(open.root, s.id)} />
          ))}
        </List>
      ) : null}
      <Markdown content={task.body} />
    </Stack>
  )
}

function FeatureDetailView({ open }: { open: Ref }) {
  const feature = read(featureDetail)
  const busyNow = read(busy)
  const header = (
    <Row justify="between">
      <Button variant="ghost" onPress={() => void back()}>Back</Button>
      {feature?.status === 'done' ? <Button variant="outline" disabled={busyNow} onPress={() => void archiveOne(open)}>Archive</Button> : null}
    </Row>
  )
  if (!feature) return <Stack gap="md">{header}{flashView() ?? <Text muted>Loading…</Text>}</Stack>
  return (
    <Stack gap="md">
      {header}
      {flashView()}
      <Heading level={2}>{feature.id} {feature.title}</Heading>
      <Row gap="xs">
        <Badge tone={feature.status === 'done' ? 'success' : 'accent'}>{feature.status}</Badge>
        {feature.openBugs > 0 ? <Badge tone="danger">{feature.openBugs} open bug{feature.openBugs > 1 ? 's' : ''}</Badge> : null}
      </Row>
      <Progress label="Feature progress" labelHidden value={feature.pct} />
      <Text muted size="xs">{feature.done}/{feature.total} done</Text>
      {feature.children.length > 0 ? (
        <List label="Tasks and bugs">
          {feature.children.map((c) => (
            <ListItem key={c.id} title={`${c.id} ${short(c.title)}`} icon={c.kind === 'bug' ? 'bug' : undefined} description={c.status} onPress={() => void openItem(open.root, c.id)} />
          ))}
        </List>
      ) : (
        <Text muted size="xs">No tasks or bugs yet. Create them with --feature {feature.id}.</Text>
      )}
      <Markdown content={feature.body} />
    </Stack>
  )
}

export default function Panel() {
  const open = top()
  if (open) return isFeature(open.id) ? <FeatureDetailView open={open} /> : <TaskDetailView open={open} />
  const data = read(board)
  const error = read(failure)
  if (!data) return error ? <Text tone="danger">{error}</Text> : <Text muted>Loading…</Text>

  if (data.focus === 'noFocus') return <EmptyState title="No project focused" description="Open a project to see its board." />
  if (data.focus === 'none') {
    return (
      <EmptyState
        title="This project does not use Orbit yet"
        description="Ask an agent to use the orbit-project skill and run `orbit init`."
      />
    )
  }

  const { agentCounts: counts } = data
  return (
    <Stack gap="md">
      {data.focus === 'ambiguous' ? (
        <Text muted size="xs">Could not tell which project is focused; showing the repos that may match.</Text>
      ) : null}
      {flashView()}
      <Row justify="between">
        <Heading>Agents</Heading>
        <Badge tone={counts.working > 0 ? 'accent' : 'neutral'}>
          {counts.working} working / {counts.total}
        </Badge>
      </Row>
      {data.agents.length === 0 ? (
        <Text muted size="xs">No agent activity seen since Orca started.</Text>
      ) : (
        <List label="Agents">
          {data.agents.map((a) => (
            <ListItem
              key={a.paneKey}
              title={a.title ?? a.paneKey}
              description={a.taskId ? `${a.repo} · ${a.taskId}` : 'no claimed task'}
            >
              <Row gap="xs">
                <AgentBadge state={a.state} />
                <RelativeTime at={a.receivedAt} muted />
              </Row>
            </ListItem>
          ))}
        </List>
      )}
      {data.repos.map((repo) => (
        <Stack key={repo.root} gap="sm">
          <Row justify="between">
            <Heading level={2}>{repo.name}</Heading>
            <Text muted size="xs">
              {repo.progress.done}/{repo.progress.total} done{repo.archivedCount > 0 ? ` · ${repo.archivedCount} archived` : ''}
            </Text>
          </Row>
          <Progress label={`${repo.name} progress`} labelHidden value={repo.progress.pct} />
          {repo.features.length > 0 ? (
            <Collapsible key={`features:${repo.features.length}`} title={`Features (${repo.features.length})`} defaultOpen>
              <List label="Features">
                {repo.features.map((f) => (
                  <ListItem
                    key={f.id}
                    title={`${f.id} ${short(f.title)}`}
                    description={`${f.done}/${f.total} · ${f.status}${f.openBugs > 0 ? ` · ${f.openBugs} open bug${f.openBugs > 1 ? 's' : ''}` : ''}`}
                    onPress={() => void openItem(repo.root, f.id)}
                  />
                ))}
              </List>
            </Collapsible>
          ) : null}
          {COLUMNS.map(({ status, title, open: defaultOpen }) => (
            <Collapsible
              // New key when the column goes empty <-> filled, so defaultOpen applies again.
              key={`${status}:${repo.columns[status].length > 0}`}
              title={`${title} (${repo.columns[status].length})`}
              defaultOpen={defaultOpen && repo.columns[status].length > 0}
            >
              <List label={title}>
                {repo.columns[status].map((t) => (
                  <ListItem
                    key={t.id}
                    title={`${t.id} ${short(t.title)}`}
                    icon={t.agent ? 'agent' : t.kind === 'bug' ? 'bug' : undefined}
                    onPress={() => void openItem(repo.root, t.id)}
                  />
                ))}
              </List>
              {status === 'done' && repo.columns.done.length > 0 ? (
                <Button variant="ghost" disabled={read(busy)} onPress={() => void archiveAllDone(repo.root)}>Archive all done</Button>
              ) : null}
            </Collapsible>
          ))}
        </Stack>
      ))}
    </Stack>
  )
}
