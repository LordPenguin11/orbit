// Output shaping for the CLI, kept small because every printed token is paid for by an agent.

/** `orbit list` hides finished work unless asked: `--all`, or an explicit `--status`. */
export function visibleByDefault(items, { all, status }) {
  return all || status ? items : items.filter((i) => i.status !== 'done')
}

/** A pane key is `<uuid>:<uuid>`; eight characters tell agents apart. A chosen owner name is kept whole. */
export function shortOwner(owner) {
  if (!owner) return '-'
  return owner.includes(':') ? owner.slice(0, 8) : owner
}
