import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import { claim, newItem } from '../lib/store.mjs'
import * as main from './main.mjs'

function repoWithClaimedTask(): { dir: string; id: string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-worker-')))
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init')
  const { id } = newItem(dir, 'task', 'Write store', { plan: '', depends: [] })
  claim(dir, id, { owner: 'pane-1', workspace: dir })
  return { dir, id }
}

test('agent_event_joins_claimed_task_and_notifies_panel', async () => {
  const { dir, id } = repoWithClaimedTask()
  const host = mockHost({
    results: {
      'workspace.list': {
        workspaces: [{ id: 'w1', kind: 'worktree', name: 'main', path: dir, branch: 'main', hostId: null }],
        truncated: false
      }
    }
  })
  const worker = await mountWorker(main, { host })
  await worker.emit('agent.status.changed', {
    workspaceId: 'w1',
    paneKey: 'pane-1',
    state: 'working',
    receivedAt: 1
  })
  const board = await worker.request('board.get', {})
  assert.equal(board.agents[0].taskId, id)
  assert.equal(board.agentCounts.working, 1)
  assert.equal(board.repos[0].columns.doing[0].id, id)
  await new Promise((r) => setTimeout(r, 300))
  assert.ok(worker.posts.some((p) => p.event === 'board.changed'))
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})
