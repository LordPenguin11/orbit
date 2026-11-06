// Panel <-> worker contract, read by src/panel.tsx and worker/main.mjs.
export type AgentState = 'working' | 'blocked' | 'waiting' | 'done'
export type Status = 'todo' | 'doing' | 'review' | 'done' | 'blocked'

export interface BoardTask {
  id: string
  title: string
  status: Status
  owner?: string
  note?: string
  waitingOn?: string[]
  agent?: { state: AgentState; title: string | null }
}
export interface TaskDetail {
  id: string
  title: string
  status: Status
  plan?: string
  created?: string
  completed?: string
  depends: string[]
  note?: string
  body: string
  /** Hash of the definition when opened; sent back so a concurrent edit is detected, not overwritten. */
  hash: string
  working: { title: string }[]
  notInterruptible: { title: string; reason: string }[]
}
export interface BoardAgent {
  paneKey: string
  title: string | null
  state: AgentState
  receivedAt: number
  taskId?: string
  repo?: string
}
export interface BoardData {
  /** project: the focused repo; ambiguous: several repos could match; none: it does not use Orbit; noFocus: nothing focused. */
  focus: 'project' | 'ambiguous' | 'none' | 'noFocus'
  repos: {
    root: string
    name: string
    columns: Record<Status, BoardTask[]>
    progress: { done: number; total: number; pct: number }
  }[]
  agents: BoardAgent[]
  agentCounts: { total: number } & Record<AgentState, number>
}

declare module 'orca' {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- declaration merging needs an interface
  interface PluginRequests {
    'board.get': { input: Record<string, never>; output: BoardData }
    'task.get': { input: { root: string; id: string }; output: TaskDetail }
    'task.update': {
      input: { root: string; id: string; title: string; body: string; status: Status; baseHash: string; pause: boolean }
      output: {
        changed: { title: boolean; body: boolean; status: boolean }
        hash: string
        paused: string[]
        skipped: { title: string; reason: string }[]
      }
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-definitions -- declaration merging needs an interface
  interface PluginPanelEvents {
    'board.changed': Record<string, never>
  }
}
