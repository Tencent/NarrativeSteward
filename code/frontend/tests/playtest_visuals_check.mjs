/**
 * 试玩缺配图时用名称占位，不得回退到内置默认图。
 *
 * 运行：node tests/playtest_visuals_check.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { playtestVisuals, PLAYTEST_MISSING_CHARACTER_ART, PLAYTEST_MISSING_LOCATION_ART } from '../src/playtestVisuals.js'

const here = dirname(fileURLToPath(import.meta.url))

const missingLocation = playtestVisuals({
  locationName: '旧钟楼',
  bgImage: '',
  isSpeech: false,
})
assert.equal(missingLocation.bgImage, '', '地点缺图时没有背景 URL')
assert.equal(missingLocation.missingLocationImage, true, '地点缺图时提示缺少配图')
assert.equal(missingLocation.charImage, '', '旁白不显示立绘')
assert.equal(missingLocation.missingCharacterImage, false, '旁白不提示角色缺图')

const hasLocation = playtestVisuals({
  locationName: '旧钟楼',
  bgImage: '/api/projects/p/assets/loc.png',
})
assert.equal(hasLocation.missingLocationImage, false, '地点有图时不提示缺图')
assert.equal(hasLocation.bgImage, '/api/projects/p/assets/loc.png')

const missingCharacter = playtestVisuals({
  locationName: '旧钟楼',
  bgImage: '/api/projects/p/assets/loc.png',
  isSpeech: true,
  speakerName: '林衡',
  isCharacterSpeaker: true,
  charImage: '',
})
assert.equal(missingCharacter.charImage, '', '角色缺图时没有立绘 URL')
assert.equal(missingCharacter.missingCharacterImage, true, '对话缺立绘时提示缺少配图')

const hasCharacter = playtestVisuals({
  isSpeech: true,
  speakerName: '林衡',
  isCharacterSpeaker: true,
  charImage: '/api/projects/p/assets/char.png',
})
assert.equal(hasCharacter.missingCharacterImage, false, '角色有图时不提示缺图')
assert.equal(hasCharacter.charImage, '/api/projects/p/assets/char.png')

const otherSpeaker = playtestVisuals({
  locationName: '王座',
  bgImage: '/api/projects/p/assets/loc.png',
  isSpeech: true,
  speakerName: '超级系统/王座试炼核心',
  isCharacterSpeaker: false,
  charImage: '',
})
assert.equal(otherSpeaker.charImage, '', '非角色发言者不请求立绘')
assert.equal(otherSpeaker.missingCharacterImage, false, '非角色发言者不提示角色缺图')

const unknownSpeaker = playtestVisuals({
  isSpeech: true,
  speakerName: '未识别发言者',
  isCharacterSpeaker: false,
  charImage: '',
})
assert.equal(unknownSpeaker.missingCharacterImage, false, '未知 speaker 不占立绘、不提示角色缺图')

const engineSource = readFileSync(join(here, '../src/hooks/usePlaytest.js'), 'utf8')
const panelSource = readFileSync(join(here, '../src/components/PlaytestPanel.jsx'), 'utf8')
assert.equal(engineSource.includes('resolveSpeakerReference'), true, '试玩引擎按六类卡片解析 speaker')
assert.equal(engineSource.includes('isCharacterSpeaker'), true, '试玩引擎区分角色立绘资格')
assert.equal(panelSource.includes('speakerDisplayName'), true, '试玩台词栏展示解析名称')
assert.equal(panelSource.includes('isCharacterSpeaker'), true, '试玩舞台只给角色占立绘位')
assert.equal(engineSource.includes('default-location.png'), false, '试玩引擎不再引用默认地点图')
assert.equal(engineSource.includes('default-character.png'), false, '试玩引擎不再引用默认立绘')
assert.equal(PLAYTEST_MISSING_LOCATION_ART, '地点卡片缺少配图', '缺图常量默认中文')
assert.equal(PLAYTEST_MISSING_CHARACTER_ART, '角色卡片缺少配图', '缺图常量默认中文')
assert.equal(panelSource.includes('playtestMissingLocationArt'), true, '试玩舞台提示地点卡片缺少配图')
assert.equal(panelSource.includes('playtestMissingCharacterArt'), true, '试玩舞台提示角色卡片缺少配图')

console.log('playtest_visuals_check: pass')

const speech = {locationName:'问钟台',bgImage:'/test.png',isSpeech:true,isCharacterSpeaker:true,speakerName:'归来'}
const closeUp = playtestVisuals({...speech,charImage:'/bell.png',imageDisplay:'scene'})
assert.equal(closeUp.bgImage, '/bell.png', '场景角色发言使用特写')
assert.equal(closeUp.charImage, '', '不在旧钟背景上再叠第二口钟')
assert.equal(closeUp.missingCharacterImage, false)
const narrationAfter = playtestVisuals({...speech,isSpeech:false,charImage:'/bell.png',imageDisplay:'scene'})
assert.equal(narrationAfter.bgImage, '/test.png', '进入旁白恢复地点画面')
assert.equal(narrationAfter.charImage, '')
const brokenCloseUp = playtestVisuals({...speech,charImage:'',imageDisplay:'scene'})
assert.equal(brokenCloseUp.bgImage, '/test.png', '特写加载失败仍保留地点背景')
assert.equal(brokenCloseUp.missingCharacterImage, true, '不隐瞒真实缺图')
const smallObject = playtestVisuals({...speech,speakerName:'照夜',charImage:'/sword.png',imageDisplay:'object'})
assert.equal(smallObject.bgImage, '/test.png')
assert.equal(smallObject.charImage, '/sword.png')
assert.equal(smallObject.portraitDisplay, 'object')
const ordinaryProp = playtestVisuals({...speech,isCharacterSpeaker:false,charImage:'/prop.png',imageDisplay:'scene'})
assert.equal(ordinaryProp.bgImage, '/test.png', '非角色不会因显示设置而取得角色资格')
assert.equal(ordinaryProp.charImage, '')
