import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runPrompt } from './run.mjs'

const base = { id: 't-4', orbitCommand: 'node /x/orbit.mjs' }

test('the_prompt_tells_the_agent_to_brief_claim_work_and_hand_off', () => {
  const p = runPrompt(base)
  assert.match(p, /node \/x\/orbit\.mjs brief t-4/)
  assert.match(p, /node \/x\/orbit\.mjs claim t-4/)
  assert.match(p, /node \/x\/orbit\.mjs status t-4 review/)
  assert.doesNotMatch(p, /subagent_type|skill for this task/)
})

test('an_agent_assignee_is_named_as_the_subagent_to_delegate_to', () => {
  assert.match(runPrompt({ ...base, assignee: 'agent:swift-expert' }), /Agent tool with subagent_type "swift-expert"/)
  assert.match(runPrompt({ ...base, assignee: 'agent:caveman:cavecrew-builder' }), /subagent_type "caveman:cavecrew-builder"/)
})

test('a_skill_assignee_is_named_as_the_skill_to_use', () => {
  assert.match(runPrompt({ ...base, assignee: 'skill:design-review' }), /Use the design-review skill for this task/)
})
