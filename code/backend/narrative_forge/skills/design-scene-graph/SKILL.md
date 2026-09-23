---
name: design-scene-graph
description: 为某个事件设计"可玩的情节图"——由若干情节 beat（旁白/独白/对话/选择点）与带解锁条件的有向边组成，effects 是唯一写状态处，按严格 JSON 模板写入 /project/scenes/<event_id>.json。当需要生成或修订某个事件的内部情节时使用。
---

# 设计场景/情节图（可玩的状态机）

把**某一个事件**的内部展开成一张可玩的情节图，写入 `/project/scenes/<event_id>.json`。它是
"事件的内部细化"，也是**唯一写状态（effects）的地方**：由 **情节 beat** + **beat 之间的有向边** 组成。

核心心智（务必理解，否则会建错模型）：

- **beat = 一个情节片段**（一段旁白/独白/对话，或一个选择点），是玩家实际读到/操作的最小单位。
- **边 = beat 之后可去的下一个 beat**。某 beat 出度>1 = 玩家在此处**做选择**（每条出边 `label` 是选项文案）。
- **时间不可逆**：整张图是**前向 DAG（无环）**；一次游玩 = 从开头 beat 沿边走到某个收尾 beat（出度=0）。
- **恰好一个开头（单入口）**：整张图**必须有且仅有一个入度为 0 的 beat** 作为唯一起点（运行时按"首个入度为 0 的 beat"进入，多余的入度 0 beat 永远进不去、成为死内容）。**可以有多个收尾 beat**（不同分支各自收尾）——它们不指向别的事件，而是靠沿途 `effects` 留下不同状态，由事件层的边条件在情节结束后分流到不同的下游事件。
- **effects 是唯一写状态处**：状态变化只写在 beat 的 `effects` 里。变量**不在这里声明**——它们在事件层
  （`events.json` 的 `state_variables`）已全局声明，这里只**引用**其 `id` 来读（边 `condition`）或写（`effects`）。
- **每个 beat 必须绑定地点 `location`**：只能引用世界设定 `locations` 分类里**已存在**的地点卡片 `id`（如 `loc-2`），
  供试玩时给情节配背景图。**不得凭空造地点**，相邻/同场景的 beat 尽量复用同一地点；确需新地点则提示"先补世界设定再重生成"。
- **边可带解锁条件**（引用状态变量）建模路径相关的可用性，语义与事件层完全一致。

内容与发言人**分离**（重要）：

- `dialogue`（对话）：`content` **只放纯台词**，**不写**"某某说："前缀、不夹旁白；说话角色写进 `speaker`。
- `monologue`（内心独白）：`content` **只放纯独白内容**；独白角色写进 `speaker`。
- `narration`（旁白）：`content` **只放场景/动作/氛围的客观叙述**，`speaker` **留空**；不含引号台词、不写"某某说/道/点头道"。
- `choice`（选择点）：`content` **只放一句面向玩家的提问/引导**（尽量 ≤20 字，如"你如何回应？"），`speaker` **留空**；**场景铺垫与角色台词一律不写进 choice**，要放到 choice 之前的独立 `narration`/`dialogue` beat。
- `speaker` **必须**是 `world.json` 里已有设定卡片的 `id`（六类均可：角色、系统/其他、势力等）。先建卡再写 speaker；禁止角色名、简称或尚未存在的 id。系统、组织等非角色卡片可以发言。
- **⚠️ 常见错误：把角色的具体话转述进 `narration`/`choice`**（即使不带引号、不写"说："，只是用冒号或"只说/点头道"这类弱化表达夹带）——这**同样违反**内容与发言人分离，必须避免。**判定标准**：只要这句话是"某个具体角色表达的观点/条件/评价/判断"，就该拆成一个独立的 `dialogue` beat（`speaker` 填该角色），`narration`/`choice` 只负责场景过渡本身、不承载任何角色的具体话。
  - ❌ 错误（转述夹带）：`{"kind":"narration","content":"堂叔也点头：能把小东西用在要处，就是本事。"}`
  - ✅ 正确（拆成两个 beat）：`{"kind":"narration","content":"堂叔看你处理妥当，微微点头。"}` + `{"kind":"dialogue","speaker":"char-uncle","content":"能把小东西用在要处，就是本事。"}`
  - ❌ 错误（选择引导语里夹带条件转述）：`{"kind":"choice","content":"堂叔带来举荐名额：过试炼可习武吃粮，过不了也许能留个杂役差事，你如何回应？"}`
  - ✅ 正确：`{"kind":"dialogue","speaker":"char-uncle","content":"若过了试炼，能习武吃粮；过不了，也许能留个杂役差事。"}` + `{"kind":"choice","content":"你如何回应堂叔的提议？"}`

规模约束（控制篇幅，别把整段小说铺进来）：

- 单个事件通常 **6~12 个 beat**；含 1~2 个选择分支的可到 **~15**。
- 单个 beat 正文 **1~3 句**（对话/独白更短、更口语）。规模适中既好读，也降低生成失败率。

## 步骤

1. **读依据**：先 `read_file /project/events.json`（**关键**：找到目标事件节点的 `title`/`summary` 作为本张情节图的内容依据；并拿到全局 `state_variables` 的 `id`/类型/取值域，供 effects/条件引用）；再 `read_file /project/world.json`（**关键**：读全部六类设定卡片，`speaker` **只能**填其中已有 `id`；拿 `locations` 里可用的地点卡片 `id` 供每个 beat 的 `location`）。若本回合主 Agent 已先写入新卡片，用新 id，不要用角色名。按需 `read_file /project/intent.md`（创作意图）。必要时 `ls /project/materials` 逐个分页读全素材（可能为空）。
2. **确定目标事件**：上层会告诉你要处理**哪个事件**（其 `event_id` 与标题）。本张图的 `event_id` 必须等于该事件节点的 `id`。
3. **先列正式出口义务**：从事件图中找出所有以当前事件为 source 的事件边；为每条边先决定
   一个终止 beat，以及一条能保证其 condition 成立的 effects 路线。优先用 `set` 写确定的
   flag/enum/scalar 里程碑，不依赖未知入场状态；只有确实表达累计过程时才用 `add`。
4. **先搭连通的可玩图**：从唯一入口连到这些终止 beat；保证忽略条件时每个 beat 都能到达。
   必须带条件时，前序路线必须能产生至少一种满足状态。
5. **再铺内容和额外分支**：围绕骨架展开 6~12 个 beat（分支多到 ~15），每新增 beat 立即接入图；
   选择点用出度>1 + 每边 `label`，新增分叉立即检查取值域覆盖。无条件兜底是推荐而非强制。
   对话/独白把说话者写进 `speaker`（**必须是已有设定卡片 id**，系统/组织等非角色也可发言），每个 beat 都从世界设定选择真实 `location`。若还没有对应卡片，不要用角色名凑合，在摘要里说明需先补世界设定。
6. **写状态（effects）**：在决定真正发生的 beat 写 effects；同一后果只写一处。scalar `set/add`
   都遵守 min/max，`add` 会在运行时截断，但不能在未知当前值时把小幅累加当作必然达到门槛。
7. **写入前自检**：逐条复核节点结构可达、条件前置状态、正式出口和死路规则。该自检只用于提高
   首次生成质量，不能表述成系统完整联合状态传播已经通过。
8. **按下方 JSON 模板写入** `/project/scenes/<event_id>.json`：
   - 文件不存在 → `write_file` 创建。
   - 已存在 → **先 `read_file` 读全现有内容，再用 `edit_file` 只改该改的部分**，保留其余既有内容（含用户手改），不要整体重写。
   - **不要修改 `/project/meta.json`、`events.json`、`world.json`、`outline.md`**；本轮只写这一个事件的情节文件。

## JSON 模板（字段结构必须严格一致）

```json
{
  "event_id": "ev-master",
  "beats": [
    { "id": "b-open", "kind": "narration", "speaker": "", "location": "loc-1", "content": "你走进师傅的静室，檀香弥漫。", "effects": [] },
    { "id": "b-choice", "kind": "choice", "speaker": "", "location": "loc-1", "content": "师傅问你为何而来，你如何应答？", "effects": [] },
    { "id": "b-humble", "kind": "dialogue", "speaker": "char-2", "location": "loc-1", "content": "弟子愚钝，恳请师父指点。", "effects": [ { "var": "rel_master", "op": "set", "value": "盟友" } ] },
    { "id": "b-arrogant", "kind": "dialogue", "speaker": "char-1", "location": "loc-1", "content": "不过如此，何须你教。", "effects": [ { "var": "rel_master", "op": "set", "value": "敌对" } ] },
    { "id": "b-end", "kind": "narration", "speaker": "", "location": "loc-1", "content": "会面结束，你退出静室。", "effects": [ { "var": "power", "op": "add", "value": 5 } ] }
  ],
  "edges": [
    { "id": "s1", "source": "b-open", "target": "b-choice", "label": "" },
    { "id": "s2", "source": "b-choice", "target": "b-humble", "label": "谦逊求教" },
    { "id": "s3", "source": "b-choice", "target": "b-arrogant", "label": "桀骜不驯" },
    { "id": "s4", "source": "b-humble", "target": "b-end", "label": "" },
    { "id": "s5", "source": "b-arrogant", "target": "b-end", "label": "" }
  ]
}
```

字段说明（**严格契约，系统会拒绝不合规的输出并要求你修正**）：

- 顶层**必须且只能**是 3 个英文键：`event_id` / `beats` / `edges`；
  `event_id` 必须等于目标事件节点的 `id`。
- **beat** 每个**只允许** `id`/`kind`/`speaker`/`content`/`location`/`effects`：
  - `kind` 只能是 `narration`（旁白）/ `monologue`（内心独白）/ `dialogue`（对话）/ `choice`（选择点）。
  - `id` 在本图内唯一。
  - `speaker`：仅 `dialogue`/`monologue` 使用，且**必须**是 `world.json` 六类卡片中全局唯一的 `id`（硬校验；角色名、简称、未知 id 都会被拒绝）；`narration`/`choice` 留空 `""`。
  - `content`：**纯内容**——`dialogue` 只放台词、`monologue` 只放独白（**不含**"某某说："前缀、不夹旁白）；`narration` 只放客观叙述、`choice` 只放一句提问（**不夹场景铺垫/角色台词**）。
  - `location`：**每个 beat 必填**，且**必须**是 `world.json` `locations` 分类里**已存在**的地点卡片 `id`（硬校验，为空或不存在会被拒绝）；尽量跨 beat 复用，**不得凭空造地点**。
  - `effects` 是数组；每个 effect **只含** `var`/`op`/`value`：
    - `var` 必须是 `events.json` 里**已声明**的状态变量 `id`。
    - `op` 只能是 `set`（赋值，flag/enum/scalar 通用）或 `add`（仅 scalar 的数值增减，value 为增量、可负）。
    - `set` 的 `value`：flag→`true`/`false`；enum→取自该变量 `allowed`；scalar→范围内整数。
      所有 scalar 的 `set/add` value 都必须是整数。
- **边** 每条**只允许** `id`/`source`/`target`/`condition`/`label`：
  - `source`/`target` 必须是已存在的 beat `id`，且**不能相等**（禁止自环）。
  - `condition`（可选）**只含** `var`/`op`/`value`：`var` 须是已声明变量；`flag`/`enum` 用 `==`/`!=`；
    `scalar` 可用 `>`/`>=`/`<`/`<=`/`==`/`!=`，但必须声明整数 `min/max` 且比较值为整数。
  - `label`：出度>1 时呈现给玩家的选项文案；出度=1 可留空。
- 整张图**必须无环**（前向 DAG），**有且仅有一个开头 beat（入度=0）**，且**至少有一个收尾 beat（出度=0）从开头可达**（忽略条件时）。多个收尾 beat 允许（不同分支各自收尾）。
- **条件路线不能假定未知入场状态**：正式出口需要某状态时，应在至少一条真实可达路径上通过 effects
  产生满足值；系统会传播实际入场状态，无需维护路线证明。
- **防死路（每个非收尾 beat 都要"走得通"）**：若某 beat 出边全带条件，应尽量覆盖变量取值域。
  拿不准是否覆盖时推荐无条件兜底；条件已覆盖全部可达状态时不强制添加。
- 文本用中文；键名保持英文原样；输出必须是**合法 JSON**。

## 数值合理性提示（软约束，非硬校验）

- 门槛尽量用离散里程碑（`flag`/`enum`）而非裸数值阈值；若某事件边要求某 scalar 达到较高阈值，
  确保沿情节能通过 `set`/`add` 合理累加到位（跳档优于 1 点 1 点），否则该路径可能玩家永远走不到。

## 质量自检

- 顶层是否正好 `event_id`/`beats`/`edges` 三个键？`event_id` 是否等于目标事件 id？
- 是否无环、**是否恰好一个开头 beat（入度=0，其余 beat 都有入边）**、能从开头走到某个收尾 beat？边的 `source`/`target` 是否都存在、无自环？
- **每个有出边的 beat 是否"走得通"？**（出边全带条件时：是否覆盖变量取值域，或建议增加兜底？）
- 每个 effect 的 `var` 是否已在 `events.json` 声明？`op`/`value` 是否与变量类型匹配？
- 选择点是否用 `kind: "choice"` + 各出边有 `label`？同一后果是否只写了一处（无重复镜像）？
- beat 数量是否适中（6~12，分支多到 ~15）？对话/独白是否只放纯内容、`speaker` 是否为已有卡片 id，旁白/选择的 `speaker` 是否留空？
- **每个 beat 是否都有 `location`，且都取自 `world.json` `locations` 里已存在的地点卡片 id**（没有凭空造地点）？
- 每个 beat 是否在忽略条件时从唯一入口结构可达？当前事件承担的正式事件边是否都有终止 beat，
  且至少一条路径的 effects 能满足其 condition？
- 条件是否有可达的前序 effects 依据？是否误把一次小幅 `add` 当成必然过门槛？
- **逐条检查每个 `narration`/`choice` beat**：里面是否夹带了某个具体角色的话（哪怕没引号、只是用冒号或"点头道/只说"这类弱化表达）？有则拆成独立的 `dialogue` beat。

## 输出

写入完成后，只向上层回一段简短摘要（beat 数 / 边数 / 主要选择分支 + 写了哪些关键状态），不要复述完整 JSON。
