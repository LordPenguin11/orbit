// Scenarios for `orca plugin check`: the panel rendered against a fake host plus a real temp repo.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineCheck } from 'orca/testing'
import { claim, newItem, setStatus } from '../lib/store.mjs'

function fixtureRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-check-')))
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init')
  const a = newItem(dir, 'task', 'Write store', { plan: 'p-1', depends: [] })
  const b = newItem(dir, 'task', 'Build panel', { plan: 'p-1', depends: [a.id] })
  newItem(dir, 'task', 'Ship it', { plan: 'p-1', depends: [b.id] })
  const c = newItem(dir, 'task', 'Review docs', { plan: 'p-1', depends: [] })
  claim(dir, a.id, { owner: 'pane-1', workspace: dir })
  setStatus(dir, c.id, 'review', 'needs eyes')
  return dir
}

const repo = fixtureRepo()

export default defineCheck({
  empty: { results: { 'workspace.list': { workspaces: [], truncated: false } } },
  busy: {
    results: {
      'workspace.list': {
        workspaces: [{ id: 'w1', kind: 'worktree', name: 'main', path: repo, branch: 'main', hostId: null }],
        truncated: false
      }
    },
    events: [
      {
        event: 'agent.status.changed',
        payload: { workspaceId: 'w1', paneKey: 'pane-1', title: 'Claude', state: 'working', receivedAt: Date.now() }
      }
    ]
  }
})
