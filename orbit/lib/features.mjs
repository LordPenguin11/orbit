// Feature rollup. Pure: a feature stores nothing about progress, it is derived from its tasks and bugs.
const ACTIVE = new Set(['doing', 'review', 'qa'])

export function rollupFeature(feature, active, archived = []) {
  const work = [...active, ...archived] // archived work is finished work
  const children = work.filter((w) => w.feature === feature.id && w.kind !== 'subtask')
  const ids = new Set(children.map((c) => c.id))
  const subtasks = work.filter((w) => w.kind === 'subtask' && ids.has(w.parent))
  const done = children.filter((c) => c.status === 'done').length
  const total = children.length
  let status = 'todo'
  if (total > 0 && done === total) status = 'done'
  else if (done > 0 || children.some((c) => ACTIVE.has(c.status))) status = 'doing'
  else if (total > 0 && children.every((c) => c.status === 'blocked')) status = 'blocked'
  return {
    id: feature.id,
    title: feature.title,
    status,
    total,
    done,
    pct: total ? Math.round((done / total) * 100) : 0,
    openBugs: children.filter((c) => c.kind === 'bug' && c.status !== 'done').length,
    subtasks: { total: subtasks.length, done: subtasks.filter((s) => s.status === 'done').length }
  }
}
