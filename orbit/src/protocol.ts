// Panel <-> worker contract, read by src/panel.tsx and worker/main.mjs.
export type AgentState = 'working' | 'blocked' | 'waiting' | 'done'
export type Status = 'todo' | 'doing' | 'review' | 'qa' | 'done' | 'blocked'

export interface BoardTask {
  id: string
  kind: 'task' | 'bug'
  title: string
  status: Status
  owner?: string
  note?: string
  waitingOn?: string[]
  agent?: { state: AgentState; title: string | null }
}
export interface FeatureRollup {
  id: string
  title: string
  status: 'todo' | 'doing' | 'blocked' | 'done'
  total: number
  done: number
  pct: number
  openBugs: number
  subtasks: { total: number; done: number }
}
export interface TaskSize {
  profile: string
  agent: string
  model: string
  effort: string
  verdict: 'ok' | 'too-small' | 'too-large' | 'unestimated' | 'profile-unusable'
  estTokens: number | null
  ratio: number | null
  range: { min: number; max: number } | null
  advice: string | null
}
export interface FeatureDetail extends FeatureRollup {
  body: string
  children: { id: string; kind: string; status: Status; title: string }[]
}
export interface TaskDetail {
  id: string
  kind: 'task' | 'bug' | 'subtask'
  title: string
  status: Status
  severity?: string
  feature?: string
  featureTitle: string | null
  parent?: string
  estTokens?: string
  profile?: string
  subtasks: { id: string; status: Status; title: string }[]
  size: TaskSize | null
  profiles: string[]
  assignee?: string
  assigneeMissing: boolean
  assignees: { key: string; source: string }[]
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
    archivedCount: number
    features: FeatureRollup[]
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
      input: {
        root: string
        id: string
        title: string
        body: string
        status: Status
        estTokens?: string
        profile?: string
        assignee?: string
        baseHash: string
        pause: boolean
      }
      output: {
        changed: { title: boolean; body: boolean; status: boolean; fields: boolean }
        hash: string
        warning?: string
        paused: string[]
        skipped: { title: string; reason: string }[]
      }
    }
    'feature.get': { input: { root: string; id: string }; output: FeatureDetail }
    'task.archive': { input: { root: string; id: string }; output: { archived: string[] } }
    'archive.done': { input: { root: string }; output: { archived: string[]; skipped: { id: string; reason: string }[] } }
    'task.run': { input: { root: string; id: string }; output: { launched: boolean; terminal: string | null; profile: string } }
  }
  // oxlint-disable-next-line typescript/consistent-type-definitions -- declaration merging needs an interface
  interface PluginPanelEvents {
    'board.changed': Record<string, never>
  }
}
