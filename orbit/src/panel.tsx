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
import type { AgentState, BoardData, Status, TaskDetail } from './protocol'

const board = atom<BoardData | null>(null)
const failure = atom<string | null>(null)

// Detail view: which task is open, its loaded data, and the edit form.
const selected = atom<{ root: string; id: string } | null>(null)
const detail = atom<TaskDetail | null>(null)
const editing = atom(false)
const stale = atom(false)
const busy = atom(false)
const notice = atom<{ tone: 'success' | 'warning' | 'danger'; text: string } | null>(null)
const draft = atom({ title: '', body: '', status: 'todo' as Status, pause: true })

const COLUMNS: { status: Status; title: string; open: boolean }[] = [
  { status: 'doing', title: 'Doing', open: true },
  { status: 'review', title: 'Review', open: true },
  { status: 'blocked', title: 'Blocked', open: true },
  { status: 'todo', title: 'Todo', open: false },
  { status: 'done', title: 'Done', open: false }
]
const STATUS_OPTIONS = COLUMNS.map((c) => ({ value: c.status, label: c.title }))
const AGENT_TONE = { working: 'accent', waiting: 'warning', blocked: 'danger', done: 'success' } as const

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))
const short = (title: string) => (title.length > 42 ? `${title.slice(0, 41)}…` : title)

async function refresh(): Promise<void> {
  try {
    set(board, await plugin.request('board.get', {}))
    set(failure, null)
  } catch (error) {
    set(failure, message(error))
  }
}

async function load(): Promise<void> {
  const open = read(selected)
  if (!open) return
  try {
    set(detail, await plugin.request('task.get', open))
  } catch (error) {
    set(notice, { tone: 'danger', text: message(error) })
  }
}

async function openTask(root: string, id: string): Promise<void> {
  set(selected, { root, id })
  set(notice, null)
  set(editing, false)
  set(stale, false)
  set(detail, null)
  await load()
}

function closeTask(): void {
  set(selected, null)
  set(detail, null)
  set(editing, false)
  void refresh()
}

function startEdit(): void {
  const task = read(detail)
  if (!task) return
  set(draft, { title: task.title, body: task.body, status: task.status, pause: true })
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
  const open = read(selected)
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
      baseHash: task.hash,
      pause: form.pause
    })
    const parts = ['Saved.']
    if (result.paused.length > 0) parts.push(`Interrupted ${result.paused.join(', ')} and asked to re-check.`)
    for (const s of result.skipped) parts.push(`${s.title} not interrupted: ${s.reason}.`)
    set(notice, { tone: result.skipped.length > 0 ? 'warning' : 'success', text: parts.join(' ') })
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

export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(
    plugin.on('board.changed', () => {
      void refresh()
      if (read(selected) && !read(editing)) void load()
    }),
    on('workspace.changed', () => void refresh())
  )
  void refresh()
}

function AgentBadge({ state }: { state: AgentState }) {
  return <Badge tone={AGENT_TONE[state]}>{state}</Badge>
}

function TaskDetailView() {
  const task = read(detail)
  const flash = read(notice)
  const isEditing = read(editing)
  const form = read(draft)
  const back = (
    <Row justify="between">
      <Button variant="ghost" onPress={closeTask}>Back</Button>
      {task && !isEditing ? <Button icon="edit" onPress={startEdit}>Edit</Button> : null}
    </Row>
  )
  if (!task) return <Stack gap="md">{back}{flash ? <Callout tone={flash.tone}>{flash.text}</Callout> : <Text muted>Loading…</Text>}</Stack>

  const meta = [
    task.plan ? `Plan ${task.plan}` : '',
    task.created ? `created ${task.created}` : '',
    task.completed ? `done ${task.completed}` : '',
    task.depends.length > 0 ? `depends on ${task.depends.join(', ')}` : ''
  ].filter(Boolean).join(' · ')
  const flashView = flash ? <Callout tone={flash.tone}>{flash.text}</Callout> : null

  if (isEditing) {
    const busyNow = read(busy)
    return (
      <Stack gap="md">
        {back}
        {flashView}
        {read(stale) ? <Button onPress={() => void reload()}>Reload latest</Button> : null}
        <Input label="Title" value={form.title} onChange={(title) => set(draft, { ...form, title })} />
        <Select
          label="Status"
          value={form.status}
          options={STATUS_OPTIONS}
          onChange={(status) => set(draft, { ...form, status: status as Status })}
        />
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

  return (
    <Stack gap="md">
      {back}
      {flashView}
      <Heading level={2}>{task.id} {task.title}</Heading>
      <Row gap="xs">
        <Badge tone={task.status === 'done' ? 'success' : task.status === 'blocked' ? 'danger' : 'accent'}>{task.status}</Badge>
        {task.working.map((a) => <Badge key={a.title} tone="accent">{a.title} working</Badge>)}
      </Row>
      {meta ? <Text muted size="xs">{meta}</Text> : null}
      {task.note ? <Callout tone="neutral">{task.note}</Callout> : null}
      <Markdown content={task.body} />
    </Stack>
  )
}

export default function Panel() {
  if (read(selected)) return <TaskDetailView />
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
            <Text muted size="xs">{repo.progress.done}/{repo.progress.total} done</Text>
          </Row>
          <Progress label={`${repo.name} progress`} labelHidden value={repo.progress.pct} />
          {COLUMNS.map(({ status, title, open }) => (
            <Collapsible
              // New key when the column goes empty <-> filled, so defaultOpen applies again.
              key={`${status}:${repo.columns[status].length > 0}`}
              title={`${title} (${repo.columns[status].length})`}
              defaultOpen={open && repo.columns[status].length > 0}
            >
              <List label={title}>
                {repo.columns[status].map((t) => (
                  <ListItem
                    key={t.id}
                    title={`${t.id} ${short(t.title)}`}
                    icon={t.agent ? 'agent' : undefined}
                    onPress={() => void openTask(repo.root, t.id)}
                  />
                ))}
              </List>
            </Collapsible>
          ))}
        </Stack>
      ))}
    </Stack>
  )
}
