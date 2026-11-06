import assert from 'node:assert/strict'
import { test } from 'node:test'
import { renderMarkdown } from './markdown.mjs'

test('raw_html_in_a_task_body_is_escaped', () => {
  const html = renderMarkdown('<img src=x onerror=alert(1)> **ok**\n\n```\n<script>x</script>\n```')
  assert.ok(!html.includes('<img'))
  assert.ok(!html.includes('<script>'))
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt; <strong>ok</strong>'))
})

test('checklist_items_keep_their_checked_state', () => {
  const html = renderMarkdown('## Steps\n\n- [x] one\n- [ ] two\n- plain')
  assert.equal(
    html,
    '<h4>Steps</h4><ul><li class="task done"><span class="box" aria-hidden="true"></span><span>one</span></li><li class="task"><span class="box" aria-hidden="true"></span><span>two</span></li><li>plain</li></ul>'
  )
})

test('markers_inside_code_spans_stay_literal_and_numbered_lists_render', () => {
  assert.equal(
    renderMarkdown('glob `**/*.ts` and **bold**'),
    '<p>glob <code>**/*.ts</code> and <strong>bold</strong></p>'
  )
  assert.equal(renderMarkdown('1. one\n2. two'), '<ol><li>one</li><li>two</li></ol>')
})
