// Which agents and skills exist for an assignee: the user's Claude config, installed plugins, and the
// workspace. A later source overrides an earlier one of the same key (workspace > user > plugin).
// Marketplace clones that were never installed are not scanned: only plugins in installed_plugins.json.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const nameOf = (text) => {
  const header = /^---\n([\s\S]*?)\n---/.exec(text)?.[1]
  return header && /^name:\s*(.+)$/m.exec(header)?.[1].trim().replace(/^["']|["']$/g, '')
}

const safeList = (dir) => {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/** agents/*.md and skills/<dir>/SKILL.md under `base`, named `<prefix><name>`. */
function scan(base, source, prefix = '') {
  const found = []
  for (const file of safeList(join(base, 'agents')).filter((f) => f.endsWith('.md'))) {
    const path = join(base, 'agents', file)
    const name = prefix + (nameOf(readFileSync(path, 'utf8')) || file.slice(0, -3))
    found.push({ key: `agent:${name}`, kind: 'agent', name, source, path })
  }
  for (const dir of safeList(join(base, 'skills'))) {
    const path = join(base, 'skills', dir, 'SKILL.md')
    if (!existsSync(path)) continue
    const name = prefix + (nameOf(readFileSync(path, 'utf8')) || dir)
    found.push({ key: `skill:${name}`, kind: 'skill', name, source, path })
  }
  return found
}

function installedPlugins(configDir) {
  try {
    const { plugins = {} } = JSON.parse(readFileSync(join(configDir, 'plugins', 'installed_plugins.json'), 'utf8'))
    return Object.entries(plugins).flatMap(([key, installs]) =>
      (Array.isArray(installs) ? installs : [installs]).map((i) => ({ prefix: `${key.split('@')[0]}:`, path: i.installPath }))
    )
  } catch {
    return []
  }
}

export function discoverCatalog({ home = homedir(), configDir = process.env.CLAUDE_CONFIG_DIR || join(home, '.claude'), workspaces = [] } = {}) {
  const byKey = new Map()
  const add = (entries) => entries.forEach((e) => byKey.set(e.key, e))
  for (const p of installedPlugins(configDir)) if (p.path) add(scan(p.path, 'plugin', p.prefix))
  add(scan(configDir, 'user'))
  add(scan(join(home, '.agents'), 'user'))
  for (const wt of workspaces) {
    add(scan(join(wt, '.claude'), 'workspace'))
    add(scan(join(wt, '.agents'), 'workspace'))
  }
  return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key))
}

/** `agent:x`, `skill:x` or a bare name that is unique in the catalog; '' clears the assignee. */
export function resolveAssignee(catalog, input) {
  if (!input) return ''
  const exact = catalog.find((e) => e.key === input)
  if (exact) return exact.key
  const unknown = () => new Error(`unknown assignee "${input}" (run: orbit assignees)`)
  if (/^(agent|skill):/.test(input)) throw unknown()
  const matches = catalog.filter((e) => e.name === input)
  if (matches.length === 1) return matches[0].key
  if (matches.length > 1) throw new Error(`ambiguous assignee "${input}": ${matches.map((m) => m.key).join(' or ')}`)
  throw unknown()
}
