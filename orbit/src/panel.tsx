// No build step: Orca compiles this TSX when it loads.
import {
  atom,
  Badge,
  Collapsible,
  EmptyState,
  Heading,
  List,
  ListItem,
  plugin,
  Progress,
  read,
  RelativeTime,
  Row,
  set,
  Stack,
  Text,
  type PanelContext
} from 'orca'
import type { AgentState, BoardData, Status } from './protocol'

const board = atom<BoardData | null>(null)
const failure = atom<string | null>(null)

const COLUMNS: { status: Status; title: string; open: boolean }[] = [
  { status: 'doing', title: 'Doing', open: true },
  { status: 'review', title: 'Review', open: true },
  { status: 'blocked', title: 'Blocked', open: true },
  { status: 'todo', title: 'Todo', open: false },
  { status: 'done', title: 'Done', open: false }
]
const AGENT_TONE = { working: 'accent', waiting: 'warning', blocked: 'danger', done: 'success' } as const

async function refresh(): Promise<void> {
  try {
    set(board, await plugin.request('board.get', {}))
    set(failure, null)
  } catch (error) {
    set(failure, error instanceof Error ? error.message : String(error))
  }
}

export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(plugin.on('board.changed', () => void refresh()))
  void refresh()
}

function AgentBadge({ state }: { state: AgentState }) {
  return <Badge tone={AGENT_TONE[state]}>{state}</Badge>
}

export default function Panel() {
  const data = read(board)
  const error = read(failure)
  if (!data) return error ? <Text tone="danger">{error}</Text> : <Text muted>Loading…</Text>

  const { agentCounts: counts } = data
  return (
    <Stack gap="md">
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
      {data.repos.length === 0 ? (
        <EmptyState
          title="No .orbit folder yet"
          description="Ask an agent to use the orbit-project skill and run `orbit init`."
        />
      ) : (
        data.repos.map((repo) => (
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
                      title={`${t.id} ${t.title}`}
                      description={[
                        t.agent?.title ?? t.owner,
                        t.waitingOn ? `waits ${t.waitingOn.join(', ')}` : '',
                        t.note
                      ].filter(Boolean).join(' · ')}
                    />
                  ))}
                </List>
              </Collapsible>
            ))}
          </Stack>
        ))
      )}
    </Stack>
  )
}
