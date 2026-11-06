// Task sizing against a profile (model + effort). Pure.
// A session pays a fixed overhead (system prompt, skills, reading the brief) before any real work, and
// degrades as its context fills. So a task's estTokens must be large enough that the overhead is a small
// share of the session, and small enough that the session stays under maxFill of maxSessionTokens:
//   overhead share  F / (F + est)        <= maxOverheadShare   =>  est >= F * (1 - share) / share
//   context fill    (F + est) / maxToks  <= maxFill            =>  est <= maxFill * maxToks - F
// Subtasks and features are not sized: subtasks share their task's session.

export const DEFAULT_CONFIG = {
  _note:
    'Starting guesses, not measurements. Tune maxSessionTokens, fixedOverheadTokens, maxOverheadShare and maxFill to what your sessions really cost.',
  sizing: {
    default: 'sonnet-medium',
    profiles: {
      'haiku-low': {
        agent: 'claude', model: 'claude-haiku-5-5', effort: 'low',
        maxSessionTokens: 120_000, fixedOverheadTokens: 20_000, maxOverheadShare: 0.4, maxFill: 0.6
      },
      'sonnet-medium': {
        agent: 'claude', model: 'claude-sonnet-5-5', effort: 'medium',
        maxSessionTokens: 200_000, fixedOverheadTokens: 25_000, maxOverheadShare: 0.3, maxFill: 0.7
      },
      'opus-high': {
        agent: 'claude', model: 'claude-opus-5-5', effort: 'high',
        maxSessionTokens: 200_000, fixedOverheadTokens: 30_000, maxOverheadShare: 0.3, maxFill: 0.75
      }
    }
  }
}

export function mergeConfig(base, override) {
  return {
    ...base,
    ...(override ?? {}),
    sizing: {
      default: override?.sizing?.default ?? base.sizing.default,
      profiles: { ...base.sizing.profiles, ...(override?.sizing?.profiles ?? {}) }
    }
  }
}

export function taskRange(p) {
  const min = Math.ceil((p.fixedOverheadTokens * (1 - p.maxOverheadShare)) / p.maxOverheadShare - 1e-9)
  const max = Math.floor(p.maxFill * p.maxSessionTokens - p.fixedOverheadTokens)
  return { min, max }
}

export function validateProfile(p) {
  const errors = []
  if (!(p.maxSessionTokens > 0)) errors.push('maxSessionTokens must be a positive number')
  if (!(p.fixedOverheadTokens >= 0)) errors.push('fixedOverheadTokens must be zero or more')
  if (!(p.maxOverheadShare > 0 && p.maxOverheadShare < 1)) errors.push('maxOverheadShare must be between 0 and 1')
  if (!(p.maxFill > 0 && p.maxFill <= 1)) errors.push('maxFill must be above 0 and at most 1')
  if (errors.length > 0) return errors
  const { min, max } = taskRange(p)
  return min > max ? [`no task size fits: the minimum (${min}) exceeds the maximum (${max})`] : []
}

export function assess(task, profile) {
  const est = Number(task.estTokens)
  if (!Number.isFinite(est) || est <= 0) return { verdict: 'unestimated', advice: 'add estTokens so the task can be sized' }
  if (validateProfile(profile).length > 0) return { verdict: 'profile-unusable', estTokens: est, advice: 'fix the profile in .orbit/config.json' }
  const { min, max } = taskRange(profile)
  const F = profile.fixedOverheadTokens
  const result = {
    estTokens: est,
    ratio: est / profile.maxSessionTokens,
    overheadShare: F / (F + est),
    fill: (F + est) / profile.maxSessionTokens,
    range: { min, max }
  }
  if (est < min) {
    return { ...result, verdict: 'too-small', advice: `merge with a neighbouring task of the same feature (about ${min - est}+ tokens more would fit) or make it a subtask of one` }
  }
  if (est > max) {
    const n = Math.ceil(est / max)
    return { ...result, verdict: 'too-large', advice: `split into ${n} tasks of about ${Math.round(est / n)} tokens each (separate sessions, not subtasks)` }
  }
  return { ...result, verdict: 'ok' }
}

/** Greedy groups of too-small tasks (same feature) whose combined estimate still fits in one session. */
export function suggestMerges(small, maxTokens) {
  const byFeature = new Map()
  for (const t of small) byFeature.set(t.feature || '', [...(byFeature.get(t.feature || '') ?? []), t])
  const merges = []
  for (const [feature, tasks] of byFeature) {
    let group = []
    let total = 0
    const flush = () => {
      if (group.length > 1) merges.push({ feature, ids: group.map((t) => t.id), total })
    }
    for (const t of tasks) {
      const est = Number(t.estTokens)
      if (total + est > maxTokens) {
        flush()
        group = []
        total = 0
      }
      group.push(t)
      total += est
    }
    flush()
  }
  return merges
}
