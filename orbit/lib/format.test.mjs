import assert from 'node:assert/strict'
import { test } from 'node:test'
import { shortOwner, visibleByDefault } from './format.mjs'

const items = [{ id: 't-1', status: 'done' }, { id: 't-2', status: 'doing' }, { id: 't-3', status: 'todo' }]

test('done_items_are_hidden_unless_all_or_an_explicit_status_is_asked', () => {
  assert.deepEqual(visibleByDefault(items, {}).map((i) => i.id), ['t-2', 't-3'])
  assert.deepEqual(visibleByDefault(items, { all: true }).map((i) => i.id), ['t-1', 't-2', 't-3'])
  // listWork has already filtered by --status, so an explicit status must not hide the done items it asked for
  assert.deepEqual(visibleByDefault([items[0]], { status: 'done' }).map((i) => i.id), ['t-1'])
})

test('a_pane_key_owner_is_shortened_and_a_chosen_name_is_kept', () => {
  assert.equal(shortOwner('df109495-2146-4b2c-b2e8-09aef6735196:ce8a4694-779f-4dce-894e-8a039638223b'), 'df109495')
  assert.equal(shortOwner('claude-1'), 'claude-1')
  assert.equal(shortOwner(''), '-')
  assert.equal(shortOwner(undefined), '-')
})
