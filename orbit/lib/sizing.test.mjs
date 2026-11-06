import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_CONFIG, assess, mergeConfig, suggestMerges, taskRange, validateProfile } from './sizing.mjs'

const profile = { maxSessionTokens: 100_000, fixedOverheadTokens: 20_000, maxOverheadShare: 0.4, maxFill: 0.6 }

test('range_is_derived_from_the_fixed_overhead_and_the_fill_limit', () => {
  // overhead share F/(F+est) <= 0.4  =>  est >= 20000*0.6/0.4 = 30000 ; fill (F+est)/max <= 0.6  =>  est <= 40000
  assert.deepEqual(taskRange(profile), { min: 30_000, max: 40_000 })
})

test('assess_reports_ratio_overhead_and_fill', () => {
  const a = assess({ estTokens: '35000' }, profile)
  assert.equal(a.verdict, 'ok')
  assert.equal(a.ratio, 0.35)
  assert.equal(Math.round(a.overheadShare * 100), 36)
  assert.equal(a.fill, 0.55)
})

test('too_small_and_too_large_tasks_get_advice', () => {
  const small = assess({ estTokens: 10_000 }, profile)
  assert.equal(small.verdict, 'too-small')
  assert.match(small.advice, /merge/i)
  const large = assess({ estTokens: 100_000 }, profile)
  assert.equal(large.verdict, 'too-large')
  assert.match(large.advice, /split into 3 tasks/)
})

test('a_task_without_an_estimate_is_unestimated_not_wrong', () => {
  assert.equal(assess({ estTokens: '' }, profile).verdict, 'unestimated')
  assert.equal(assess({}, profile).verdict, 'unestimated')
  assert.equal(assess({ estTokens: 'lots' }, profile).verdict, 'unestimated')
})

test('a_profile_whose_range_is_empty_is_flagged', () => {
  const broken = { ...profile, fixedOverheadTokens: 60_000, maxOverheadShare: 0.2 }
  assert.deepEqual(validateProfile(broken), ['no task size fits: the minimum (240000) exceeds the maximum (0)'])
  assert.equal(assess({ estTokens: 50_000 }, broken).verdict, 'profile-unusable')
})

test('validate_profile_checks_numbers', () => {
  assert.deepEqual(validateProfile(profile), [])
  assert.match(validateProfile({ ...profile, maxFill: 1.5 })[0], /maxFill/)
  assert.match(validateProfile({ ...profile, maxSessionTokens: 0 })[0], /maxSessionTokens/)
})

test('suggest_merges_groups_small_tasks_of_a_feature_up_to_the_maximum', () => {
  const small = [
    { id: 't-1', feature: 'f-1', estTokens: 12_000 },
    { id: 't-2', feature: 'f-1', estTokens: 14_000 },
    { id: 't-3', feature: 'f-1', estTokens: 15_000 },
    { id: 't-4', feature: 'f-2', estTokens: 10_000 },
    { id: 't-5', feature: 'f-2', estTokens: 11_000 }
  ]
  assert.deepEqual(suggestMerges(small, 40_000), [
    { feature: 'f-1', ids: ['t-1', 't-2'], total: 26_000 },
    { feature: 'f-2', ids: ['t-4', 't-5'], total: 21_000 }
  ])
})

test('merge_config_lets_a_project_override_and_add_profiles', () => {
  const merged = mergeConfig(DEFAULT_CONFIG, {
    sizing: { default: 'mine', profiles: { mine: { ...profile, model: 'x' }, 'sonnet-medium': { ...profile } } }
  })
  assert.equal(merged.sizing.default, 'mine')
  assert.equal(merged.sizing.profiles.mine.model, 'x')
  assert.equal(merged.sizing.profiles['sonnet-medium'].maxSessionTokens, 100_000)
  assert.ok(merged.sizing.profiles['opus-high'], 'untouched defaults stay')
  assert.equal(mergeConfig(DEFAULT_CONFIG, null).sizing.default, DEFAULT_CONFIG.sizing.default)
})

test('default_profiles_are_valid_and_marked_as_starting_guesses', () => {
  for (const [name, p] of Object.entries(DEFAULT_CONFIG.sizing.profiles)) {
    assert.deepEqual(validateProfile(p), [], name)
    assert.ok(p.model && p.effort && p.agent, `${name} names its agent, model and effort`)
  }
  assert.match(DEFAULT_CONFIG._note, /guess/i)
})
