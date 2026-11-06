#!/usr/bin/env node
// Orbit CLI used by the orbit-project skill. Usage: see SKILL.md.
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { claim, findPrimaryRoot, listTasks, newItem, setStatus } from '../../../lib/store.mjs'

const { positionals, flags } = (() => {
  const positionals = []
  const flags = {}
  const args = process.argv.slice(2)
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('--')) positionals.push(args[i])
    else if (args[i + 1] === undefined || args[i + 1].startsWith('--')) flags[args[i].slice(2)] = true
    else flags[args[i].slice(2)] = args[++i]
  }
  return { positionals, flags }
})()

const fail = (msg) => {
  console.error(`orbit: ${msg}`)
  process.exit(1)
}
const [cmd, sub, ...rest] = positionals
const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).trim()

try {
  const root = findPrimaryRoot(process.cwd())
  if (cmd === 'init') {
    for (const d of ['plans', 'docs', 'tasks']) mkdirSync(join(root, '.orbit', d), { recursive: true })
    console.log(`${root}/.orbit ready`)
  } else if (cmd === 'plan' || cmd === 'doc' || cmd === 'task') {
    if (sub === 'new') {
      const title = rest.join(' ') || fail(`${cmd} new needs a title`)
      const depends = typeof flags.depends === 'string' ? flags.depends.split(',').map((s) => s.trim()) : []
      const { id } = newItem(root, cmd, title, { plan: flags.plan ?? '', depends })
      console.log(id)
    } else if (cmd === 'task' && sub === 'claim') {
      const owner = flags.owner || process.env.ORBIT_AGENT || process.env.ORCA_PANE_KEY
      if (!owner) fail('no agent identity: pass --owner or set ORBIT_AGENT')
      const data = claim(root, rest[0] ?? fail('claim needs a task id'), {
        owner,
        workspace: git('rev-parse', '--show-toplevel'),
        worktree: process.env.ORCA_WORKTREE_ID
      })
      console.log(`${data.id} doing owner=${data.owner}`)
    } else if (cmd === 'task' && sub === 'status') {
      const note = typeof flags.note === 'string' ? flags.note : undefined
      const data = setStatus(root, rest[0] ?? fail('status needs a task id'), rest[1] ?? fail('status needs a value'), note)
      console.log(`${data.id} ${data.status}`)
    } else if (cmd === 'task' && sub === 'list') {
      const tasks = listTasks(root, { status: typeof flags.status === 'string' ? flags.status : undefined })
      if (flags.json) console.log(JSON.stringify(tasks, null, 2))
      else for (const t of tasks) console.log(`${t.id}\t${t.status}\t${t.owner || '-'}\t${t.title}`)
    } else fail(`unknown: ${cmd} ${sub ?? ''}`)
  } else fail('commands: init | plan new | doc new | task new|claim|status|list')
} catch (e) {
  fail(e.message)
}
