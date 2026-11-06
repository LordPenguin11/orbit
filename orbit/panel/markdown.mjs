// Small markdown subset for task bodies. Input is escaped first, so output never carries raw HTML.
const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

export const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ENTITIES[c])

// Code spans are cut out first so `**` inside them stays literal.
const inline = (text) =>
  text
    .split(/(`[^`]+`)/)
    .map((part) =>
      /^`[^`]+`$/.test(part)
        ? `<code>${escapeHtml(part.slice(1, -1))}</code>`
        : escapeHtml(part).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    )
    .join('')

const BULLET = /^\s*(?:([-*])|\d+[.)])\s+(?:\[( |x|X)\]\s+)?(.*)$/

function listItem(line) {
  const m = BULLET.exec(line)
  if (!m) {
    return null
  }
  const text = inline(m[3])
  const ordered = m[1] === undefined
  if (m[2] === undefined) {
    return { ordered, html: `<li>${text}</li>` }
  }
  const done = m[2] !== ' '
  return {
    ordered,
    html: `<li class="task${done ? ' done' : ''}"><span class="box" aria-hidden="true"></span><span>${text}</span></li>`
  }
}

export function renderMarkdown(source) {
  const out = []
  const lines = String(source ?? '').split('\n')
  let paragraph = []
  let items = []
  let ordered = false
  const flush = () => {
    if (paragraph.length > 0) {
      out.push(`<p>${inline(paragraph.join(' '))}</p>`)
    }
    if (items.length > 0) {
      out.push(ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`)
    }
    paragraph = []
    items = []
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.trimStart().startsWith('```')) {
      flush()
      const code = []
      for (i++; i < lines.length && !lines[i].trimStart().startsWith('```'); i++) {
        code.push(lines[i])
      }
      out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`)
      continue
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line)
    if (heading) {
      flush()
      out.push(`<h4>${inline(heading[1])}</h4>`)
      continue
    }
    const item = listItem(line)
    if (item) {
      if (paragraph.length > 0 || (items.length > 0 && ordered !== item.ordered)) {
        flush()
      }
      ordered = item.ordered
      items.push(item.html)
      continue
    }
    if (line.trim() === '') {
      flush()
    } else {
      if (items.length > 0) {
        flush()
      }
      paragraph.push(line.trim())
    }
  }
  flush()
  return out.join('')
}
