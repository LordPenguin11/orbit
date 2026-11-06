#!/usr/bin/env node
// Orbit CLI used by the orbit-project skill. Usage: see SKILL.md.
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  archiveDone,
  archiveItem,
  catalogFor,
  claim,
  listArchived,
  listWork,
  migrate,
  newItem,
  profileFor,
  profileTable,
  readBrief,
  setStatus,
  sizeReport,
  taskDiff,
  unarchiveItem
} from '../../../lib/store.mjs'
import { shortOwner, visibleByDefault } from '../../../lib/format.mjs'
import { assess } from '../../../lib/sizing.mjs'

const CREATABLE = new Set(['plan', 'doc', 'feature', 'task', 'bug', 'subtask'])
const VERBS = new Set(['claim', 'status', 'diff', 'brief', 'archive', 'unarchive', 'list'])
const pct = (x) => `${Math.round(x * 100)}%`

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
const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).trim()
const text = (name) => (typeof flags[name] === 'string' ? flags[name] : undefined)
const needId = (rest, verb) => rest[0] ?? fail(`${verb} needs an id`)

let [cmd, ...rest] = positionals
const cwd = process.cwd()

try {
  if (CREATABLE.has(cmd) && rest[0] === 'new') {
    const title = rest.slice(1).join(' ') || fail(`${cmd} new needs a title`)
    const sized = cmd === 'task' || cmd === 'bug'
    const profile = sized ? profileFor(cwd, text('profile')) : null // fails early on an unknown profile
    const { id } = newItem(cwd, cmd, title, {
      plan: text('plan'),
      feature: text('feature'),
      parent: text('parent'),
      severity: text('severity'),
      profile: text('profile'),
      assignee: text('assignee'),
      estTokens: text('est'),
      depends: text('depends')?.split(',').map((s) => s.trim()) ?? []
    })
    console.log(id)
    if (sized) {
      const a = assess({ estTokens: text('est') }, profile)
      if (a.verdict === 'unestimated') console.error(`note: ${id} has no --est, so it cannot be sized against ${profile.name}`)
      else if (a.verdict !== 'ok') console.error(`warning: ${id} is ${a.verdict} for ${profile.name} (est ${a.estTokens}, fits ${a.range?.min}-${a.range?.max}): ${a.advice}`)
    }
  } else {
    // `task claim t-3`, `bug status b-1 qa` and `claim t-3` are the same command.
    if (CREATABLE.has(cmd) && VERBS.has(rest[0])) [cmd, ...rest] = rest
    if (cmd === 'init') {
      const top = git('rev-parse', '--show-toplevel')
      for (const d of ['plans', 'docs', 'features', 'tasks']) mkdirSync(join(top, '.orbit', d), { recursive: true })
      console.log(`${top}/.orbit ready`)
    } else if (cmd === 'migrate') {
      console.log(`migrated ${migrate(cwd)} task file(s)`)
    } else if (cmd === 'claim') {
      const owner = flags.owner || process.env.ORBIT_AGENT || process.env.ORCA_PANE_KEY
      if (!owner) fail('no agent identity: pass --owner or set ORBIT_AGENT')
      const id = needId(rest, 'claim')
      claim(cwd, id, { owner, workspace: git('rev-parse', '--show-toplevel'), worktree: process.env.ORCA_WORKTREE_ID })
      console.log(`${id} doing owner=${owner}`)
    } else if (cmd === 'status') {
      const id = needId(rest, 'status')
      const status = rest[1] ?? fail('status needs a value')
      const { warning } = setStatus(cwd, id, status, text('note'))
      console.log(`${id} ${status}`)
      if (warning) console.log(`warning: ${warning}`)
    } else if (cmd === 'diff') {
      console.log(taskDiff(cwd, needId(rest, 'diff')))
    } else if (cmd === 'brief') {
      console.log(readBrief(cwd, needId(rest, 'brief')))
    } else if (cmd === 'archive') {
      if (flags.done) {
        const { archived, skipped } = archiveDone(cwd)
        console.log(`archived ${archived.length}: ${archived.join(' ') || '-'}`)
        for (const s of skipped) console.log(`skipped ${s.id}: ${s.reason}`)
      } else {
        console.log(`archived ${rest.length ? rest.flatMap((id) => archiveItem(cwd, id)).join(' ') : fail('archive needs an id or --done')}`)
      }
    } else if (cmd === 'unarchive') {
      console.log(`restored ${unarchiveItem(cwd, needId(rest, 'unarchive')).join(' ')}`)
    } else if (cmd === 'assignees') {
      const catalog = catalogFor(cwd)
      if (flags.json) console.log(JSON.stringify(catalog, null, 2))
      else for (const e of catalog) console.log(`${e.key}\t${e.source}`)
    } else if (cmd === 'size') {
      if (rest[0] === 'profiles') {
        for (const p of profileTable(cwd)) {
          console.log(`${p.name}\t${p.agent} ${p.model} ${p.effort}\tsession ${p.maxSessionTokens}\toverhead ${p.fixedOverheadTokens}\ttask fits ${p.range.min}-${p.range.max} tokens`)
        }
      } else {
        const { items, merges } = sizeReport(cwd)
        if (flags.json) console.log(JSON.stringify({ items, merges }, null, 2))
        else {
          for (const i of items) {
            console.log(`${i.id}\t${i.verdict}\t${i.ratio === undefined ? '-' : pct(i.ratio)}\t${i.profile}\t${i.title}`)
            if (i.verdict !== 'ok') console.log(`\t-> ${i.advice}`)
          }
          for (const m of merges) console.log(`merge ${m.ids.join(' + ')} (${m.total} tokens, ${m.profile}${m.feature ? `, ${m.feature}` : ''})${m.stillSmall ? ' still below the minimum: add more work to it' : ''}`)
        }
      }
    } else if (cmd === 'list') {
      const filter = { status: text('status'), kind: text('kind'), feature: text('feature') }
      const items = flags.archived ? listArchived(cwd) : visibleByDefault(listWork(cwd, filter), { all: flags.all, status: filter.status })
      if (flags.json) console.log(JSON.stringify(items, null, 2))
      else for (const t of items) console.log(`${t.id}\t${t.status}\t${shortOwner(t.owner)}\t${t.title}`)
    } else {
      fail('commands: init | migrate | <plan|doc|feature|task|bug|subtask> new "<title>" | claim | status | diff | brief | size | assignees | archive | unarchive | list')
    }
  }
} catch (e) {
  fail(e.message)
}
