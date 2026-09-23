---
name: extract-worldview
description: 从小说/策划案原文与故事大纲中抽取并组织结构化世界设定，按"子类型分组的统一卡片"JSON 模板写入 /project/world.json。当需要生成或修订世界设定时使用。
---

# 抽取世界设定（分类卡片）

把素材与大纲，提炼为结构化、可供后续创作复用的世界设定，写入 `/project/world.json`。
设定按**子类型分组**——世界观 / 角色 / 地点 / 势力 / 历史 / 其他，每组是一组**统一卡片**。

## 步骤

1. **读依据**：先 `read_file /project/intent.md`（创作意图）与 `/project/outline.md`（故事大纲——设定要服务于大纲里出现的实体）；再 `ls /project/materials` 并**逐个分页读全**素材（默认只读前 100 行，用 `offset` 续读至末尾，据行号确认已覆盖全文；素材可能多份、也可能为空）。
2. **分类抽取**：把内容归入 worldview / characters / locations / factions / history / other 六类，每条信息做成一张卡片。**大纲里出现的关键角色/地点/势力都应有对应卡片。**
3. **保真优先**：忠于素材与大纲，不引入冲突设定；合理补全要克制。
4. **按下方 JSON 模板写入** `/project/world.json`：
   - 文件不存在 → `write_file` 创建（`write_file` 不能覆盖已存在文件）。
   - 已存在 → **先 `read_file` 读全现有内容，再用 `edit_file` 只改该改的部分，保留其余既有内容（含用户手改），不要整体重写。**
   - **不要修改 `/project/meta.json`，也不要写 `outline.md`。**

## JSON 模板（字段结构必须严格一致）

```json
{
  "worldview": [
    { "id": "wv-1", "name": "概念/规则名", "description": "该世界观概念的说明", "tags": [], "image": "" }
  ],
  "characters": [
    { "id": "char-1", "name": "角色名", "description": "外貌/性格/背景/动机的综合描述", "tags": ["主角", "失忆"], "image": "" }
  ],
  "locations": [
    { "id": "loc-1", "name": "地点名", "description": "地点描述", "tags": [], "image": "" }
  ],
  "factions": [
    { "id": "fac-1", "name": "势力名", "description": "势力描述（含与其他势力的关系）", "tags": [], "image": "" }
  ],
  "history": [
    { "id": "his-1", "name": "事件/时期名", "description": "影响当下的重要背景历史", "tags": [], "image": "" }
  ],
  "other": [
    { "id": "oth-1", "name": "条目名", "description": "难以归入上面分类的设定", "tags": [], "image": "" }
  ]
}
```

字段说明（**严格契约，系统会拒绝不合规的输出并要求你修正**）：
- 顶层**必须且只能**是这 6 个**英文**键：`worldview` / `characters` / `locations` / `factions` / `history` / `other`。
  **禁止**把键名翻译成中文（不要用 `世界观`/`角色` 等做键），也**禁止**新增其它顶层键；某类暂无内容就给空数组 `[]`。
- 每张卡片**只允许** `id` / `name` / `description` / `tags` 四个键，**不得新增** `summary`/`details`/`connections`/`role` 等字段——
  更丰富的信息（背景、关系、定位等）一律合并写进 `description` 字符串（可用换行或"- "分点）。
- `id`：稳定标识（如 `char-1`，供后续事件层引用，**同类内唯一**）；`name` 必填；`tags` 为字符串数组，可为空。
- 卡片正文用中文；键名保持英文原样；输出必须是**合法 JSON**（注意逗号、引号、括号闭合）。

## 质量自检

- 大纲里出现的关键实体是否都建了卡片？角色/势力/地点关系是否自洽？命名是否与原文/大纲一致？
- 顶层是否正好是 6 个**英文**键？每张卡片是否**只含** `id/name/description/tags/image` 五个键、
  `name` 非空、`id` 同类唯一？新增卡片的 `image` 是否为空字符串，修订时是否保留了已有配图？JSON 是否合法？

## 输出

写入完成后，只向上层回一段简短摘要（各类卡片数量 + 一句话总体设定印象），不要复述完整 JSON。
