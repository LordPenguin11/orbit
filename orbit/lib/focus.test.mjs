import assert from 'node:assert/strict'
import { test } from 'node:test'
import { agentsInRepo, resolveFocus } from './focus.mjs'

const ws = (path, name = 'main', branch = 'main') => ({ id: `identity:${path}`, kind: 'worktree', name, branch, path })
const ctx = (over = {}) => ({ displayName: 'main', branch: 'main', terminals: [], ...over })
const none = () => false
const all = () => true

test('no_focus_when_nothing_is_focused', () => {
  assert.deepEqual(resolveFocus(null, [ws('/a')], { usesOrbit: none }), { noFocus: true })
})

test('exact_workspace_from_an_agent_terminal_match', () => {
  const r = resolveFocus(ctx({ terminals: [{ id: 'term-9' }] }), [ws('/a'), ws('/b')], {
    usesOrbit: all,
    terminalWorkspace: new Map([['term-9', 'uuid-1::/b']])
  })
  assert.deepEqual(r, { path: '/b' })
})

test('unique_name_and_branch_resolves', () => {
  const list = [ws('/a', 'OrbitIDE'), ws('/b', 'other')]
  assert.deepEqual(resolveFocus(ctx({ displayName: 'OrbitIDE' }), list, { usesOrbit: all }), { path: '/a' })
})

test('a_resolved_workspace_that_does_not_use_orbit_means_none', () => {
  const list = [ws('/a', 'OrbitIDE')]
  assert.deepEqual(resolveFocus(ctx({ displayName: 'OrbitIDE' }), list, { usesOrbit: none }), { none: true })
  const viaTerminal = resolveFocus(ctx({ terminals: [{ id: 't' }] }), list, {
    usesOrbit: none,
    terminalWorkspace: new Map([['t', 'u::/a']])
  })
  assert.deepEqual(viaTerminal, { none: true })
})

test('same_name_is_resolved_by_the_only_repo_that_uses_orbit', () => {
  const list = [ws('/a'), ws('/b'), ws('/c')]
  assert.deepEqual(resolveFocus(ctx(), list, { usesOrbit: (p) => p === '/b' }), { path: '/b' })
})

test('same_name_with_no_orbit_repo_means_this_project_does_not_use_orbit', () => {
  assert.deepEqual(resolveFocus(ctx(), [ws('/a'), ws('/b')], { usesOrbit: none }), { none: true })
  assert.deepEqual(resolveFocus(ctx({ displayName: 'ghost' }), [ws('/a')], { usesOrbit: none }), { none: true })
})

test('several_orbit_candidates_are_reported_as_ambiguous', () => {
  const r = resolveFocus(ctx(), [ws('/a'), ws('/b'), ws('/c')], { usesOrbit: (p) => p !== '/c' })
  assert.deepEqual(r, { ambiguous: ['/a', '/b'] })
})

test('agents_in_repo_keeps_only_agents_inside_the_repo_worktrees', () => {
  const agents = [
    { paneKey: 'p1', workspaceId: 'u::/repo' },
    { paneKey: 'p2', workspaceId: 'u::/repo-wt' },
    { paneKey: 'p3', workspaceId: 'u::/elsewhere' },
    { paneKey: 'p4', workspaceId: null },
    { paneKey: 'p5', workspaceId: 'identity:wt2:x' }
  ]
  assert.deepEqual(agentsInRepo(agents, ['/repo', '/repo-wt']).map((a) => a.paneKey), ['p1', 'p2'])
})
