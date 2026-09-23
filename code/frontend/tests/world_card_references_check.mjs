/**
 * 世界设定六类卡片索引与 speaker 硬引用解析。
 *
 * 运行：node tests/world_card_references_check.mjs
 */

import assert from 'node:assert/strict'

import {
  UNKNOWN_SPEAKER_LABEL,
  buildWorldCardIndex,
  resolveSpeakerReference,
  speakerSelectOptions,
} from '../src/worldCardReferences.js'

const world = {
  characters: [{ id: 'char-1', name: '林衡' }],
  locations: [{ id: 'loc-1', name: '旧钟楼' }],
  other: [{ id: 'oth-1', name: '超级系统/王座试炼核心' }],
  factions: [{ id: 'fac-1', name: '灰铸商会' }],
  worldview: [],
  history: [],
}

const index = buildWorldCardIndex(world)

const otherSpeaker = resolveSpeakerReference('oth-1', index)
assert.equal(otherSpeaker.displayName, '超级系统/王座试炼核心', 'oth-1 显示设定卡片名称')
assert.equal(otherSpeaker.category, 'other', 'oth-1 归入其他分类')
assert.equal(otherSpeaker.resolved, true)
assert.equal(otherSpeaker.isCharacterSpeaker, false, '非角色没有立绘资格')
assert.equal(otherSpeaker.unknown, false)

const characterSpeaker = resolveSpeakerReference('char-1', index)
assert.equal(characterSpeaker.displayName, '林衡')
assert.equal(characterSpeaker.isCharacterSpeaker, true, '角色卡片有立绘资格')
assert.equal(characterSpeaker.category, 'characters')

const uniqueName = resolveSpeakerReference('灰铸商会', index)
assert.equal(uniqueName.resolved, false, '卡片名称不能当作 speaker')
assert.equal(uniqueName.displayName, UNKNOWN_SPEAKER_LABEL)
assert.equal(uniqueName.unknown, true)

const freeName = resolveSpeakerReference('堂叔', index)
assert.equal(freeName.displayName, UNKNOWN_SPEAKER_LABEL)
assert.equal(freeName.resolved, false)
assert.equal(freeName.isCharacterSpeaker, false, '自由名称不占立绘')
assert.equal(freeName.unknown, true)

const unknownId = resolveSpeakerReference('oth-missing', index)
assert.equal(unknownId.displayName, UNKNOWN_SPEAKER_LABEL, '未知 id 显示未识别发言者')
assert.equal(unknownId.unknown, true)
assert.equal(unknownId.isCharacterSpeaker, false)

const duplicate = buildWorldCardIndex({
  characters: [{ id: 'shared-1', name: '角色侧' }],
  other: [{ id: 'shared-1', name: '系统侧' }],
})
const ambiguous = resolveSpeakerReference('shared-1', duplicate)
assert.equal(ambiguous.ambiguous, true, '跨分类重复 id 视为歧义')
assert.equal(ambiguous.resolved, false)
assert.equal(ambiguous.displayName, UNKNOWN_SPEAKER_LABEL, '歧义 id 不静默挑选')
assert.equal(ambiguous.isCharacterSpeaker, false)

const options = speakerSelectOptions(index, 'oth-1')
assert.equal(options[0].value, '')
assert.ok(options.some((item) => item.value === 'oth-1' && item.label.includes('其他')))
assert.ok(options.some((item) => item.value === 'char-1' && item.label.includes('角色')))
const damaged = speakerSelectOptions(index, 'missing-id')
assert.ok(damaged.some((item) => item.value === 'missing-id' && item.label.includes(UNKNOWN_SPEAKER_LABEL)))

console.log('world_card_references_check: pass')
