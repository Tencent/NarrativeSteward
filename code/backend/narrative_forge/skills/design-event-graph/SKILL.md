---
name: design-event-graph
description: 基于故事大纲与世界设定，把故事细化为"网状的事件图"——声明全局状态变量 + 事件节点 + 带解锁条件的有向边，按严格 JSON 模板写入 /project/events.json。当需要生成或修订事件图时使用。
---

# 设计事件图（图 + 状态变量）

把弱格式大纲细化成一张**网状的事件图**写入 `/project/events.json`。事件图是"细化版的大纲"，
由三部分组成：**全局状态变量声明** + **事件节点** + **事件之间的有向边**。

核心心智（务必理解，否则会建错模型）：

- **节点 = 一个梗概级事件**（如"入门""见师傅""闭关"），只写梗概，**不写状态变化**。
- **边 = 事件之后可选的后续事件**，表示时间/因果关联。某事件出度>1 = 玩家在此处选择"接下来做哪件事"。
- **时间不可逆**：整张图是**前向 DAG（无环）**；一次游玩 = 从入口沿边走出的一条路径。
- **边可带解锁条件**（引用状态变量）来建模长期影响。例：闭关后就见不到师傅，可表示为
  通往"见师傅"的边带条件 `in_seclusion == false`，或那条路径干脆不存在。
- **事件层不写状态、不独立试玩**：状态的"写入（effects）"是后续**场景层**的事，**这里只声明变量 + 用变量做边的条件**。

## 步骤

1. **读依据**：先 `read_file /project/intent.md`（创作意图）、`/project/outline.md`（故事大纲，事件图是它的细化）、`/project/world.json`（世界设定——事件的参与角色/地点要引用其中卡片的 `id`）；再 `ls /project/materials` 并**逐个分页读全**素材（默认只读前 100 行，用 `offset` 续读至末尾；素材可能多份、也可能为空）。
2. **先定状态变量**：从故事里提炼少量**关键**的全局状态变量（关系、阵营、是否习得某能力、是否做过某抉择等）。**门槛尽量用离散里程碑**（`flag`/`enum`）而非裸数值，`scalar` 仅用于细腻刻画，尽量不作硬解锁门槛。
3. **铺事件节点**：把大纲主线拆成事件节点，标好 `type`（主线/可选/结局），用 `characters`/`locations` 引用 `world.json` 的卡片 `id`。**至少要有一个 `ending` 结局节点。**
4. **先连可达骨架**：选唯一入口，保证忽略条件时每个事件都能从入口到达。必须带条件时，优先使用
   source scene 可通过明确 `set` 达成的 flag/enum 里程碑；scalar 门槛须落在范围内，并能自然写到。
5. **再扩展额外选择**：每增加节点立即接入完整图；每增加分叉立即写好 `label` 并检查条件覆盖。
   无条件兜底是降低死路风险的推荐做法，但条件已覆盖全部可达状态时不强制添加。
6. **写入前自检**：逐项核对节点覆盖、拓扑连通、边引用、条件类型和非结局出边。该自检用于减少
   首次生成错误，不能表述成系统已经真实走通。
7. **按下方 JSON 模板写入** `/project/events.json`：
   - 文件不存在 → `write_file` 创建。
   - 已存在 → **先 `read_file` 读全现有内容，再用 `edit_file` 只改该改的部分**，保留其余既有内容（含用户手改），不要整体重写。
   - **不要修改 `/project/meta.json`，也不要给事件节点加 `effects` 字段（那是场景层的事）。**

## JSON 模板（字段结构必须严格一致）

```json
{
  "state_variables": [
    { "id": "rel_master", "name": "与师傅的关系", "type": "enum", "allowed": ["敌对", "中立", "盟友"], "initial": "中立", "description": "随剧情选择变化的师徒关系" },
    { "id": "in_seclusion", "name": "是否闭关", "type": "flag", "initial": false, "description": "一旦闭关，将错过部分支线" },
    { "id": "power", "name": "武力", "type": "scalar", "min": 0, "max": 100, "initial": 1, "description": "修为水平，仅作刻画/排序" }
  ],
  "nodes": [
    { "id": "ev-start", "title": "入门", "summary": "主角拜入门派，初见同门。", "type": "mainline", "characters": ["char-1"], "locations": ["loc-1"] },
    { "id": "ev-master", "title": "见师傅", "summary": "前往拜见师傅，态度将影响关系。", "type": "mainline", "characters": ["char-2"], "locations": ["loc-2"] },
    { "id": "ev-seclusion", "title": "闭关", "summary": "选择闭关苦修，错过见师傅的时机。", "type": "optional", "characters": ["char-1"], "locations": [] },
    { "id": "ev-end", "title": "出师", "summary": "学有所成，离派远行。", "type": "ending", "characters": ["char-1"], "locations": [] }
  ],
  "edges": [
    { "id": "e-1", "source": "ev-start", "target": "ev-master", "condition": { "var": "in_seclusion", "op": "==", "value": false }, "label": "去见师傅" },
    { "id": "e-2", "source": "ev-start", "target": "ev-seclusion", "label": "直接闭关苦修" },
    { "id": "e-3", "source": "ev-master", "target": "ev-end", "label": "" },
    { "id": "e-4", "source": "ev-seclusion", "target": "ev-end", "label": "" }
  ]
}
```

字段说明（**严格契约，系统会拒绝不合规的输出并要求你修正**）：

- 顶层**必须且只能**是 3 个英文键：`state_variables` / `nodes` / `edges`。
- **状态变量** 每个**只允许** `id`/`name`/`type`/`allowed`/`min`/`max`/`initial`/`description`，且须类型自洽：
  - `type` 只能是 `flag`（布尔）/ `enum`（离散标签）/ `scalar`（数值）。
  - `flag`：`initial` 为 `true`/`false`，**不要**写 `allowed`/`min`/`max`。
  - `enum`：必须有非空 `allowed`，`initial` 取自 `allowed`，**不要**写 `min`/`max`。
  - `scalar`：必须同时声明整数 `min/max`；`initial` 如填写也必须是范围内整数，全部 condition value
    和后续 scene 的所有 `set/add` value 都必须是整数。**不支持无界或小数 scalar，不要写 `allowed`。**
  - `id` 在状态变量内唯一。
- **事件节点** 每个**只允许** `id`/`title`/`summary`/`type`/`characters`/`locations`，**不得新增** `effects` 等字段：
  - `type` 只能是 `mainline`/`optional`/`ending`；**至少有一个 `ending`**。
  - `id` 在节点内唯一；`characters`/`locations` 是字符串数组，元素应是 `world.json` 里对应卡片的 `id`。
- **边** 每条**只允许** `id`/`source`/`target`/`condition`/`label`：
  - `source`/`target` 必须是已存在的节点 `id`，且**不能相等**（禁止自环）。
  - `condition`（可选）**只含** `var`/`op`/`value`：`var` 必须是已声明的状态变量 `id`；
    `flag`/`enum` 只能用 `==`/`!=`（`enum` 的 `value` 取自 `allowed`）；`scalar` 可用 `>`/`>=`/`<`/`<=`/`==`/`!=`，但变量必须双侧有界且 `value` 为范围内整数。
  - `label`：出度>1 时呈现给玩家的选项文案；出度=1 可留空。
- 整张图**必须无环**（前向 DAG），且**至少有一个结局节点从入口可达**（忽略条件时）。
- **每条条件边都必须有可实现依据**：source scene 应能在某条真实玩法上通过 effects 达成条件；系统会
  在全部 scene 齐全后传播联合状态，不要在 JSON 中手写路线证明。
- **防死路（每个非结局节点都要"走得通"）**：非结局事件必须至少有一条出边；若出边全带条件，
  应尽量覆盖变量取值域。拿不准是否覆盖时推荐无条件兜底；条件已覆盖全部可达状态时不强制添加。
- 文本用中文；键名保持英文原样；输出必须是**合法 JSON**。

## 质量自检

- 顶层是否正好 `state_variables`/`nodes`/`edges` 三个键？是否有至少一个 `ending`？
- 是否无环、能从开头走到某个结局？边的 `source`/`target` 是否都存在、无自环？
- 每个事件是否在忽略条件时从唯一入口结构可达？
- 每条条件边的 source 事件是否有明确、可实现的状态写入方案？
- **每个非结局、有出边的节点是否"走得通"？**（出边全带条件时：是否覆盖取值域，或建议增加兜底？）
- 每条 `condition` 引用的变量是否已声明、运算符与取值是否匹配其类型？
- 节点是否引用了 `world.json` 里真实存在的角色/地点卡片 `id`？是否误给节点加了 `effects`？

## 输出

写入完成后，只向上层回一段简短摘要（状态变量数 / 节点数 / 边数 + 一句话主线与主要分支），不要复述完整 JSON。
