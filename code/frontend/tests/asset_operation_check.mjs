/**
 * 角色/地点配图操作文案、全局进度与 Agent 互斥契约。
 *
 * 运行：node tests/asset_operation_check.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  ASSET_OPERATION_ACTIONS,
  formatAssetOperationBusyReason,
  formatAssetOperationLabel,
  formatAssetOperationStatus,
  formatAssetOperationWait,
  resolveAssetFileAction,
  resolveAssetGenerateAction,
} from '../src/assetOperation.js'

const here = dirname(fileURLToPath(import.meta.url))

assert.equal(resolveAssetFileAction(false), 'upload')
assert.equal(resolveAssetFileAction(true), 'replace')
assert.equal(resolveAssetGenerateAction(false), 'generate')
assert.equal(resolveAssetGenerateAction(true), 'regenerate')

assert.equal(
  formatAssetOperationLabel({ category: 'characters', cardName: '林恩', action: 'upload' }),
  '正在为角色「林恩」上传配图',
)
assert.equal(
  formatAssetOperationLabel({ category: 'locations', cardName: '旧钟楼', action: 'replace' }),
  '正在为地点「旧钟楼」更换配图',
)
assert.equal(
  formatAssetOperationLabel({ category: 'characters', cardName: '林恩', action: 'generate' }),
  '正在为角色「林恩」生成配图',
)
assert.equal(
  formatAssetOperationLabel({ category: 'locations', cardName: '旧钟楼', action: 'regenerate' }),
  '正在为地点「旧钟楼」重新生成配图',
)
assert.equal(
  formatAssetOperationLabel({ category: 'characters', cardName: '  ', action: 'generate' }),
  '正在为角色「未命名」生成配图',
)
assert.equal(formatAssetOperationWait(1_000, 1_000), '已等待 0 秒')
assert.equal(formatAssetOperationWait(1_000, 19_000), '已等待 18 秒')
assert.equal(
  formatAssetOperationStatus(
    { category: 'locations', cardName: '旧钟楼', action: 'regenerate', startedAt: 1_000 },
    26_000,
  ),
  '正在为地点「旧钟楼」重新生成配图 · 已等待 25 秒',
)
assert.equal(
  formatAssetOperationBusyReason({ category: 'characters', cardName: '林恩', action: 'generate' }),
  '正在为角色「林恩」生成配图，完成后可继续对话',
)
assert.equal(ASSET_OPERATION_ACTIONS.upload.buttonBusy, '上传中…')
assert.equal(ASSET_OPERATION_ACTIONS.replace.buttonBusy, '更换中…')
assert.equal(ASSET_OPERATION_ACTIONS.generate.buttonBusy, '生图中…')
assert.equal(ASSET_OPERATION_ACTIONS.regenerate.buttonBusy, '重新生图中…')

const appSource = readFileSync(join(here, '../src/App.jsx'), 'utf8')
const worldSource = readFileSync(join(here, '../src/components/WorldForm.jsx'), 'utf8')
const gridSource = readFileSync(join(here, '../src/components/fields/CardGrid.jsx'), 'utf8')
const chatSource = readFileSync(join(here, '../src/components/ChatPanel.jsx'), 'utf8')
const sidebarSource = readFileSync(join(here, '../src/components/Sidebar.jsx'), 'utf8')
const statusSource = readFileSync(join(here, '../src/components/ProjectOperationStatus.jsx'), 'utf8')
const cssSource = readFileSync(join(here, '../src/styles.css'), 'utf8')

assert.match(appSource, /<ProjectOperationStatus operation=\{assetOperation\} \/>/, '项目标题下挂载全局配图状态条')
assert.match(appSource, /Boolean\(assetOperation\)/, '配图进行中把内容区置为只读')
assert.match(
  appSource,
  /if \(assetOperationRef\.current\) \{\s*setBanner\(formatAssetOperationBusyReason/,
  '发送 Agent 前再次检查配图操作',
)
assert.match(appSource, /busyReason=\{assetBusyReason \|\| undefined\}/, 'Agent 输入使用配图原因而不是笼统生成中')
assert.match(appSource, /onAssetOperationChange=\{handleAssetOperationChange\}/, '世界设定把配图操作上报到 App')
assert.match(
  appSource,
  /if \(assetOperationRef\.current && id !== selectedIdRef\.current\)/,
  '配图进行中禁止切换项目',
)
assert.match(worldSource, /onAssetOperationChange=\{onAssetOperationChange\}/, 'WorldForm 把回调交给卡片网格')
const worldSubtabs = worldSource.match(/<div className="subtabs">[\s\S]*?<\/div>/)
assert.ok(worldSubtabs, '设定页有二级分类标签')
assert.doesNotMatch(worldSubtabs[0], /disabled=\{disabled\}/, '设定二级标签不受只读 disabled 控制')
assert.match(worldSource, /<FragmentShell[\s\S]*disabled=\{disabled\}/, '保存外壳仍只读')
assert.match(worldSource, /<CardGrid[\s\S]*disabled=\{disabled\}/, '卡片网格仍只读')
assert.match(gridSource, /beginOperation\(resolveAssetFileAction/, '选择文件后立即登记上传或更换')
assert.match(gridSource, /beginOperation\(resolveAssetGenerateAction/, '确认后立即登记生成或重新生成')
assert.match(gridSource, /finally \{\s*endOperation\(\)/, '成功或失败都清掉进行中状态')
assert.match(gridSource, /onChange\(res\.path\)/, '完成后把配图路径写入当前草稿')
assert.match(gridSource, /artifacts\.world\.generated/, '生图完成后仍提示保存 world 草稿')
assert.match(chatSource, /busyReason/, 'ChatPanel 接受配图忙碌原因')
assert.match(
  chatSource,
  /const showStop = \(turnPhase === 'running' \|\| stopping\)/,
  '停止并撤销只跟 Agent 回合走，配图忙碌不会出现该按钮',
)
assert.match(sidebarSource, /disabled=\{disabled && p\.id !== selectedId\}/, '配图进行中禁用切换到其它项目')
assert.match(statusSource, /role="status"/, '全局条可供读屏听到')
assert.match(statusSource, /setInterval\(\(\) => setNow\(Date\.now\(\)\), 1000\)/, '每秒更新已等待时间')
assert.match(cssSource, /\.build-global-status/, '全局条有独立样式')

console.log('asset_operation_check: pass')
