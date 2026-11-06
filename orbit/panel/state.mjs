// Shared panel state and constants.
export const COLUMNS = [
  ['doing', 'Doing'],
  ['review', 'Review'],
  ['qa', 'QA'],
  ['blocked', 'Blocked'],
  ['todo', 'Todo'],
  ['done', 'Done']
]
export const COLUMN_GAP = 12

export const LAYOUT_KEY = 'orbit.layout'
const savedLayout = () => {
  try {
    const value = localStorage.getItem(LAYOUT_KEY)
    return value === 'columns' ? value : 'list'
  } catch {
    return 'list'
  }
}

export const state = {
  board: null,
  boardKey: '',
  itemKey: '',
  failure: null,
  tab: 'board',
  layout: savedLayout(),
  repo: null,
  stack: [],
  detail: null,
  feature: null,
  editing: false,
  stale: false,
  busy: false,
  notice: null,
  draft: null,
  collapsed: {}
}

export const top = () => state.stack.at(-1) ?? null
export const isFeature = (id) => id.startsWith('f-')
export const message = (error) => (error instanceof Error ? error.message : String(error))
