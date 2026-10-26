import assert from 'node:assert/strict'
import { formatPlayStateValue, describePlayCondition } from '../src/playStatePresentation.js'
import { createTranslator } from '../src/i18n/translate.js'
const zh = createTranslator('zh-CN'), en = createTranslator('en-US')
const flag = { name: '是否受伤', type: 'flag' }
assert.equal(formatPlayStateValue(flag, true, zh), '是')
assert.equal(formatPlayStateValue(flag, false, zh), '否')
assert.equal(formatPlayStateValue(flag, true, en), 'Yes')
assert.equal(formatPlayStateValue(flag, false, en), 'No')
assert.equal(formatPlayStateValue({ ...flag, value_descriptions: { true: '受伤', false: '完好' } }, false, zh), '完好')
assert.equal(formatPlayStateValue(flag, undefined, zh), '未设置')
assert.equal(formatPlayStateValue({}, 0, zh), '0')
assert.equal(formatPlayStateValue({}, 'unmapped', zh), 'unmapped')
const companion = { name: '同行旧器', value_descriptions: { sword: '照夜', mirror: '留影' } }
assert.equal(describePlayCondition({var:'c', op:'==', value:'mirror'}, {c:'sword'}, {c:companion}, zh), '需要：同行旧器为留影\n当前：同行旧器为照夜')
for (const [op, phrase] of Object.entries({'==':'为','!=':'不为','>':'大于','>=':'至少为','<':'小于','<=':'至多为'})) {
  assert.equal(describePlayCondition({var:'power', op, value:3}, {power:1}, {power:{name:'灵力'}}, zh), `需要：灵力${phrase}3\n当前：灵力为1`)
}
assert.equal(describePlayCondition({var:'hurt', op:'==', value:true}, {hurt:false}, {hurt:flag}, en), 'Requires: 是否受伤 is Yes\nCurrent: 是否受伤 is No')
assert.equal(describePlayCondition(null, {}, {}, zh), '')
console.log('PASS player state meanings, booleans, missing values and all six condition operators')
