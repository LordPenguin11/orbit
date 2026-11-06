import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { discoverCatalog, resolveAssignee } from './catalog.mjs'

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'orbit-cat-')))
const write = (file, text) => {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, text)
}
const agent = (dir, name, extra = '') => write(join(dir, 'agents', `${name}.md`), `---\nname: ${name}\ndescription: ${name} agent${extra}\n---\nbody\n`)
const skill = (dir, name) => write(join(dir, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: >-\n  ${name} skill\n---\nbody\n`)
const keys = (catalog) => catalog.map((e) => `${e.key}@${e.source}`).sort()

function setup() {
  const home = tmp()
  const config = join(home, '.claude')
  const workspace = tmp()
  agent(config, 'android-expert')
  skill(config, 'design-review')
  skill(join(home, '.agents'), 'orca-cli')
  agent(join(workspace, '.claude'), 'repo-reviewer')
  skill(join(workspace, '.claude'), 'repo-skill')
  return { home, config, workspace }
}

test('finds_agents_and_skills_in_user_agents_dir_and_workspace_with_their_source', () => {
  const { home, config, workspace } = setup()
  assert.deepEqual(keys(discoverCatalog({ home, configDir: config, workspaces: [workspace] })), [
    'agent:android-expert@user',
    'agent:repo-reviewer@workspace',
    'skill:design-review@user',
    'skill:orca-cli@user',
    'skill:repo-skill@workspace'
  ])
})

test('only_installed_plugins_count_and_their_names_are_namespaced', () => {
  const { home, config } = setup()
  const installed = join(config, 'plugins', 'cache', 'caveman')
  agent(installed, 'cavecrew-builder')
  skill(installed, 'caveman')
  // a marketplace clone that was never installed must not show up
  agent(join(config, 'plugins', 'marketplaces', 'big-pack'), 'ghost-agent')
  write(join(config, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'caveman@caveman': [{ scope: 'user', installPath: installed }] } }))
  const found = keys(discoverCatalog({ home, configDir: config, workspaces: [] }))
  assert.ok(found.includes('agent:caveman:cavecrew-builder@plugin'))
  assert.ok(found.includes('skill:caveman:caveman@plugin'))
  assert.equal(found.some((k) => k.includes('ghost-agent')), false)
})

test('a_symlinked_config_dir_does_not_duplicate_entries', () => {
  const { home, config } = setup()
  symlinkSync(config, join(home, '.claude-shared'))
  const installed = join(home, '.claude-shared', 'plugins', 'cache', 'p')
  agent(installed, 'shared-agent')
  write(join(config, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'p@m': [{ installPath: installed }] } }))
  const found = keys(discoverCatalog({ home, configDir: config, workspaces: [] }))
  assert.equal(found.filter((k) => k.startsWith('agent:p:shared-agent')).length, 1)
})

test('a_workspace_entry_overrides_a_user_entry_of_the_same_name', () => {
  const { home, config, workspace } = setup()
  agent(join(workspace, '.claude'), 'android-expert')
  const mine = discoverCatalog({ home, configDir: config, workspaces: [workspace] }).filter((e) => e.key === 'agent:android-expert')
  assert.deepEqual(mine.map((e) => e.source), ['workspace'])
})

test('missing_dirs_and_a_broken_plugin_list_are_ignored', () => {
  const home = tmp()
  mkdirSync(join(home, '.claude', 'plugins'), { recursive: true })
  writeFileSync(join(home, '.claude', 'plugins', 'installed_plugins.json'), '{ not json')
  assert.deepEqual(discoverCatalog({ home, configDir: join(home, '.claude'), workspaces: ['/does/not/exist'] }), [])
})

test('resolve_assignee_accepts_keys_and_unique_bare_names_and_clears_with_empty', () => {
  const { home, config, workspace } = setup()
  const catalog = discoverCatalog({ home, configDir: config, workspaces: [workspace] })
  assert.equal(resolveAssignee(catalog, ''), '')
  assert.equal(resolveAssignee(catalog, 'agent:android-expert'), 'agent:android-expert')
  assert.equal(resolveAssignee(catalog, 'android-expert'), 'agent:android-expert')
  assert.equal(resolveAssignee(catalog, 'design-review'), 'skill:design-review')
})

test('resolve_assignee_rejects_unknown_and_ambiguous_names_with_a_hint', () => {
  const { home, config } = setup()
  agent(config, 'twin')
  skill(config, 'twin')
  const catalog = discoverCatalog({ home, configDir: config, workspaces: [] })
  assert.throws(() => resolveAssignee(catalog, 'nope'), /unknown assignee "nope".*orbit assignees/)
  assert.throws(() => resolveAssignee(catalog, 'skill:nope'), /unknown assignee/)
  assert.throws(() => resolveAssignee(catalog, 'twin'), /ambiguous.*agent:twin.*skill:twin/)
})
