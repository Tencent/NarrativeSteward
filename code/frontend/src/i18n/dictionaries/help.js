export const help = {
  'zh-CN': {
    overlay: {
      finish: '我已了解，开始创作',
      later: '稍后再看',
      saving: '保存中…',
      progress: '快速上手 {current} / {total}',
      locate: '定位到修改',
      changeRecord: '修改记录',
      contentLocation: '内容位置'
    },
    center: {
      search: '搜索概念',
      searchPlaceholder: '例如：事件、状态变量、检测',
      empty: '没有匹配的概念。可以换一个词，或从左侧分类看。',
      overview: '概念总览',
      related: '相关概念',
      goToView: '去当前界面查看',
      goDisabledDemo: '演示项目只用来认界面，请到自己的项目里查看。',
      goDisabledUnavailable: '当前没有可打开的项目。',
      learnAbout: '了解{term}',
      learnMore: '了解更多',
      why: '为什么需要',
      example: '例子',
      where: '在哪里改',
      caution: '注意',
      categories: {
        workflow: '对话、保存与试玩',
        artifacts: '分层产物',
        structure: '事件与情节',
        state: '状态与条件',
        check: '检测'
      }
    },
    concept: {
      agent: {
        term: 'Agent',
        summary: '右侧对话助手。你用自然语言说出目标，它可以代写或代改项目里的正式内容。',
        why: '同一件事既可以在中间面板自己改，也可以让 Agent 代做，不必先学会所有按钮。',
        example: '你可以说“把岔路口的选择问句改得更自然”，它会改正式情节，并在回复下给出修改摘要。',
        where: '构建页和试玩页共用右侧同一栏。试玩时展开它，还可以附带当前画面再提问。'
      },
      agentChangeset: {
        term: '修改摘要',
        summary: 'Agent 真正改了项目后，这条回复下面会出现待检查的改动清单。',
        why: '先看改了什么，再决定保留、整轮撤销，或继续对话当作默认接受。',
        example: '摘要里可能写：情节节点「beat-choose」的问句从「往哪边？」改成「你要往哪边走？」。',
        where: '在右侧对话里点「查看细节」。每条差异旁的「定位」会打开对应面板。',
        caution: '两按钮都不点、直接继续对话或自己去改项目，系统会视为接受这一轮。'
      },
      materials: {
        term: '素材',
        summary: '给你和 Agent 看的参考文本，读者在试玩里看不到。',
        why: '有草稿或灵感时可以先丢在这里，但不必须先上传才能开始写。',
        example: '一段世界观摘录、一篇灵感短文。页面可以完全空着。',
        where: '构建页的「素材」标签。支持上传或粘贴纯文本。'
      },
      intent: {
        term: '意图',
        summary: '写给自己看的故事方向，不直接变成可玩内容。',
        why: '提醒你和 Agent 不要写跑偏，例如题材、气氛、希望读者做什么选择。',
        example: '“短篇岔路选择：让读者在草地和树林之间做一次有后果的决定。”',
        where: '构建页的「意图」标签。在自己的项目中填写创作意图。'
      },
      outline: {
        term: '大纲',
        summary: '故事路线图。互动叙事里常常要写出选 A 或选 B 分别会怎样。',
        why: '大纲改了，后面的事件和情节通常也要跟着改。',
        example: '“走到岔路口；向左去草地结局，向右进树林结局。”',
        where: '构建页的「大纲」标签。可以先写大纲再拆事件，也可以反过来。'
      },
      worldCard: {
        term: '设定卡',
        summary: '反复用到的人、地点等登记成卡片，事件和情节可以点选引用。',
        why: '避免同一角色在不同地方变成两个人；试玩也用卡片上的配图做立绘和背景。',
        example: '角色「行路人」有立绘，地点「岔路口」有背景图。',
        where: '构建页的「设定」标签。角色和地点可以上传或生成配图。'
      },
      event: {
        term: '事件',
        summary: '读者会经过的一个大阶段，对应事件图上的一个方块。',
        why: '没有事件，读者就没有可走的路。事件比单独一句台词更大。',
        example: '“走到岔路口”是一个事件，“在草地歇脚”是另一个。',
        where: '构建页的「事件」标签。一级面板里还包括事件列表、状态变量和完整检测。'
      },
      eventNetwork: {
        term: '事件图',
        summary: '外层图。方块是事件，连线表示读者可以从这里走到那里。',
        why: '互动叙事不是一章接一章，而是一张有分叉的网。',
        example: '演示里，岔路口通向草地结局和树林结局。带锁的连线表示还要满足某个状态。',
        where: '事件页的「事件图」。点方块或连线打开右侧检查器。'
      },
      eventList: {
        term: '事件列表',
        summary: '按条管理事件，并进入某一个事件内部的情节图。',
        why: '不想在图上找时，可以在列表里打开还没写完的事件。',
        example: '列表会标明哪个事件已经写了情节、哪个还是空的。',
        where: '事件页的「事件列表」。点「查看情节图」进入内层。'
      },
      sceneNetwork: {
        term: '情节图',
        summary: '某一个事件里面的内层图。试玩时实际读到的，主要是这里的内容。',
        why: '事件图管大路，情节图管走进这个阶段之后具体看见什么。',
        example: '岔路口内部：到达旁白 → 选择点 → 向左或向右各一段旁白。',
        where: '从事件列表或事件检查器进入「查看情节图」。'
      },
      beat: {
        term: '情节节点',
        summary: '情节图里的一小段：旁白、对话、独白或选择点。',
        why: '读者一屏一屏看到的正文，就写在这些节点上。',
        example: '选择点的正文是问句「你要往哪边走？」；旁白写到达岔路口时的环境。',
        where: '情节检查器。旁白/对话/独白改正文；选择点的选项在「从这里出发」。'
      },
      choice: {
        term: '选择',
        summary: '读者可以点的去向。选择点上的正文是问句，真正的选项是拉出去的连线。',
        why: '同一处伸出两条指向不同后续的线，读者才会感到选择有后果。',
        example: '“向左，走向草地”和“向右，走进树林”。',
        where: '选择点检查器的「从这里出发」，或图上点那条边。'
      },
      stateVariable: {
        term: '状态变量',
        summary: '故事用来记住此前选择、并影响后路的记事本。',
        why: '后面的选项可以读取它，决定这条路能不能走。',
        example: '演示里的「所选道路」：还没选是 undecided，向左写成 meadow，向右写成 woods。',
        where: '事件页的「状态变量」。写入发生在情节节点，读取发生在连线条件。'
      },
      variableTypes: {
        term: '变量类型',
        summary: 'flag 是是否，enum 是互斥标签，scalar 是有上下限的整数。',
        why: '类型决定能怎么写入、能怎么比较，写错类型后面的条件会对不上。',
        example: 'flag「有没有钥匙」用 set true/false；enum「所选道路」set 成 meadow；scalar「体力」可以用 add -1。',
        where: '状态变量检查器里选类型、填取值和初始值。'
      },
      stateWrite: {
        term: '状态写入',
        summary: '读者经过这一拍时，改变某个状态变量。',
        why: '构建页改的是定义和初始值，不会在试玩中途自动改；真正变化发生在写入。',
        example: '向左的旁白把「所选道路」set 成 meadow。scalar 还可以 add，例如体力 -1。',
        where: '情节节点检查器里的「状态写入」。'
      },
      unlockCondition: {
        term: '解锁条件',
        summary: '按状态变量当前值，决定这条路能不能进入。',
        why: '条件不满足时，试玩里这条选项会灰掉。',
        example: '通向草地结局的事件连线要求「所选道路」等于 meadow。',
        where: '事件连线或情节连线的检查器。flag/enum 用等于或不等于；scalar 还可以比较大小。'
      },
      draftSave: {
        term: '草稿与保存',
        summary: '中间每页的直接编辑先留在草稿，点「保存」才写入项目。',
        why: '未保存时不要让 Agent 执行，以免覆盖你正在改的内容。',
        example: '改了事件标题后，标签上会出现未保存标记，点保存后才成为正式版本。',
        where: '各构建页顶部或底部的「保存」「放弃草稿修改」。',
        caution: '保存成功后，检测常常变成「尚未检测」，这表示内容已更新，不是报错。'
      },
      validation: {
        term: '完整检测',
        summary: '从入口沿真实选项往前推，检查当前版本能不能跑通。',
        why: '只检查结构、引用和路线，不给故事打分。',
        example: '演示已经通过：两条结局都可达，没有死路。',
        where: '事件页的「完整检测」。修改故事后可运行检测，查看当前版本的问题。'
      },
      validationStatuses: {
        term: '检测状态',
        summary: '尚未检测、通过、失败、内容不完整，是结构状态，不评价故事质量。',
        why: '改过内容后，上次检测结果不再适用，需要时再跑一次。',
        example: '保存或 Agent 写入后常见「尚未检测」；缺情节文件会变成「内容不完整」。',
        where: '完整检测页顶部的状态标题。'
      },
      playtest: {
        term: '试玩',
        summary: '用当前内容从入口走到结局，看读者实际会经历什么。',
        why: '构建写的是结构，试玩是把画面走一遍；发现走不通再回去改。',
        example: '走到岔路口会看到问句和两个选项；到达结局事件会出现结局卡。',
        where: '中间顶栏从「构建」切到「试玩」。灰掉的选项通常是条件还没满足。'
      }
    },
    hints: {
      firstEmptyProjectAgent: {
        title: '从一句话开始创作',
        body: '在右侧告诉 Agent 你想创作的故事，例如题材、氛围或一个关键选择。Agent 可以帮你逐步建立大纲、设定、事件和具体情节。'
      },
      firstChangeset: {
        title: 'Agent 改动可以先看摘要',
        body: '点「查看细节」看改了哪些事件或情节，不必立刻接受全部建议。'
      },
      firstChangesetLocate: {
        title: '每条改动都可以定位到原文',
        body: '点右侧「定位」，中间会打开这一处内容，方便对着上下文检查和编辑。'
      },
      firstMaterials: {
        title: '素材是给你和 Agent 看的参考',
        body: '这里可以放草稿、摘录或灵感。读者在试玩里看到的是正式情节，不是这些参考文本。'
      },
      firstIntent: {
        title: '意图记下故事方向',
        body: '用几句话写清题材、氛围，以及希望读者经历的核心选择。它提醒你和 Agent 不要写跑偏，本身不会变成可玩内容。'
      },
      firstOutline: {
        title: '大纲规划主要路线',
        body: '用文字写出主要事件，以及选 A 或选 B 之后分别会怎样。大纲改了，后面的事件和情节通常也要跟着改。'
      },
      firstWorld: {
        title: '设定卡保存可复用的人和地点',
        body: '把反复出现的角色、地点登记成卡片，事件和情节可以点选引用。角色和地点的配图也会用在试玩里。'
      },
      firstEventNetwork: {
        title: '事件图是故事的外层路线',
        body: '方块是读者会经过的大阶段，连线表示可以从这里走到那里。带锁的连线表示还要满足某个状态。'
      },
      firstEventList: {
        title: '事件列表用来进入内部情节',
        body: '按条查看每个事件有没有写好情节。可以从这里生成情节，或打开某一个事件内部的情节图。'
      },
      firstSceneNetwork: {
        title: '情节图是读者实际读到的内容',
        body: '这是某一个事件里面的旁白、对话、选择和它们之间的连接。试玩时一屏一屏看到的，主要写在这里。'
      },
      firstVariables: {
        title: '状态变量记住已经发生的事',
        body: '这里定义变量；真正改值发生在情节的「状态写入」，读取发生在连线的解锁条件。'
      },
      firstLockedChoice: {
        title: '灰掉的选项通常是条件未满足',
        body: '把鼠标放在选项上能看到原因。回到构建改写入或条件后，再重新试玩。'
      },
      firstSaveUnchecked: {
        title: '保存后会变成「尚未检测」',
        body: '这表示内容已更新，上次检测结果不再适用。需要时再点「检测」。'
      },
      firstValidation: {
        title: '完整检测检查故事结构能否运行',
        body: '它会从故事入口沿当前选项和条件往前推，查找不可达内容、死路、缺失情节和无效引用。检测状态只反映结构是否完整、路线是否可走，不评价故事质量。'
      },
      firstPlaytest: {
        title: '试玩按你写的选项走',
        body: '走到结局时会出现结局卡。可以从这里重新试玩或返回构建。'
      },
      firstWorldCardInspector: {
        title: '打开卡片后可以改内容和配图',
        body: '世界观、角色、地点、势力、历史和其他卡片共用这种编辑方式。角色和地点还支持上传或更换配图、一键生图和重新生图；角色图会进入试玩立绘，地点图会进入试玩背景。'
      },
      firstEventNodeInspector: {
        title: '事件节点是外层故事阶段',
        body: '这里可以改标题、梗概、类型，以及出场角色和地点，并管理从这里出发的选择。'
      },
      firstEventEdgeInspector: {
        title: '事件边是读者可选的去向',
        body: '一条边包含给玩家看的文案、目标事件，以及可选的解锁条件。'
      },
      firstSceneBeatInspector: {
        title: '情节节点是读者实际读到的一屏',
        body: '它可以是旁白、对话、独白或选择问句，并设置地点、发言人和状态写入。选择点也属于情节节点。'
      },
      firstSceneEdgeInspector: {
        title: '情节边连接两个节点',
        body: '从选择点发出的边会成为读者选项，也可以带解锁条件。'
      },
      firstVariableInspector: {
        title: '打开变量后可以看它怎么被用',
        body: '这里设置类型、初始值和取值含义，并看到它在哪些情节被写入、在哪些连线上被读取。'
      }
    },
    steps: {
      layoutSidebar: {
        title: '项目管理',
        body: '左侧用于创建、选择和管理项目。选择项目后，中间的项目工作区和右侧 Agent 都会围绕当前项目工作。需要时，可以用顶部按钮收起或重新展开左侧面板。'
      },
      layoutBuild: {
        title: '项目工作区',
        body: '中间是项目工作区，用于对项目内容进行结构化的查看、编辑、分析与体验。你可以在这里管理素材、故事规划、世界设定、事件和具体情节，也可以切换到试玩，检查读者实际看到的故事。'
      },
      layoutAgent: {
        title: 'Agent 协作区',
        body: '右侧是 Agent 协作区。你可以用自然语言说明创作目标、询问当前项目，或让 Agent 创建和修改内容；Agent 的执行过程、处理结果和项目改动都会显示在这里。需要时，可以用顶部按钮收起或重新展开该面板。'
      },
      agentInput: {
        title: '输入要求',
        body: '在这里输入希望 Agent 完成的工作。要求可以直接描述目标，也可以补充需要处理的对象、范围和限制，例如“把岔路口的选择问句改得更自然，让玩家一眼知道要做什么”。'
      },
      agentExample: {
        title: '用户请求',
        body: '这条请求同时说明了处理对象——岔路口的选择问句，以及预期效果——表达更自然、意图更明确。要求越具体，Agent 的结果就越容易检查。'
      },
      agentResponse: {
        title: 'Agent 处理结果',
        body: 'Agent 完成工作后，会在回复中说明处理结果，包括完成了什么、影响了哪些内容，以及是否还有需要确认的问题。对于修改项目内容的请求，回复下方还会提供本轮修改记录。'
      },
      agentChangesetToggle: {
        title: '展开修改细节',
        body: '折叠行已经显示修改数量和处理状态。点击「查看细节」后，才会展示每一处具体改动。'
      },
      agentChangesetDetails: {
        title: '核对本轮修改',
        body: '这里列出本轮改动涉及的对象和修改前后内容，便于确认实际发生了什么。你可以保留整轮修改，也可以整轮撤销；如果继续对话或开始手动编辑，系统会将这轮修改视为已接受。'
      },
      agentLocate: {
        title: '定位修改',
        body: '每条修改右侧都有「定位」按钮。点击后，项目工作区会打开这处内容，便于结合上下文检查和编辑。'
      },
      checkModifiedContent: {
        title: '检查修改内容',
        body: '右侧修改记录和中间内容位置对应同一句。可以结合上下文继续检查，也可以在这里手动编辑。'
      },
      playtestOpen: {
        title: '打开试玩',
        body: '顶部可以在「构建」和「试玩」之间切换。「构建」用于查看和编辑项目内容；点击「试玩」可以从读者视角体验故事。'
      },
      playtestOpening: {
        title: '从故事开头开始',
        body: '试玩从故事开头开始。旁白、对话和选择会推动故事前进。'
      },
      playtestResult: {
        title: '以读者视角做选择',
        body: '推进到岔路口后，可以看到问句与可选路径，并确认它们是否符合预期。'
      },
      playtestAgent: {
        title: '结合当前情景询问',
        body: '试玩时，Agent 可以附带当前事件、情节和本局状态。你可以直接询问当前画面，例如“这个问句还能更自然吗”或“为什么这个选项无法选择”，不必重新描述所在位置。'
      },
      finishNormal: {
        title: '随时查看概念说明',
        body: '快速上手只介绍最基本的协作流程。需要了解事件、情节、状态变量或检测等概念时，可以随时打开概念说明；界面中的局部问号会直接打开对应内容。现在可以创建或打开自己的项目开始创作。'
      }
    }
  },
  'en-US': {
    overlay: {
      finish: 'Got it, start writing',
      later: 'Later',
      saving: 'Saving…',
      progress: 'Quick start {current} / {total}',
      locate: 'Go to the change',
      changeRecord: 'Change record',
      contentLocation: 'Content location'
    },
    center: {
      search: 'Search concepts',
      searchPlaceholder: 'For example: event, state variable, verification',
      empty: 'No matching concepts. Try another word, or browse the list.',
      overview: 'Concept overview',
      related: 'Related concepts',
      goToView: 'Show this in the workspace',
      goDisabledDemo: 'The demo is only for learning the interface. Open this in your own project.',
      goDisabledUnavailable: 'There is no project to open.',
      learnAbout: 'Learn about {term}',
      learnMore: 'Learn more',
      why: 'Why it exists',
      example: 'Example',
      where: 'Where to edit it',
      caution: 'Note',
      categories: {
        workflow: 'Chat, save, and playtest',
        artifacts: 'Layered artifacts',
        structure: 'Events and beat graphs',
        state: 'State and conditions',
        check: 'Verification'
      }
    },
    concept: {
      agent: {
        term: 'Agent',
        summary: 'The chat assistant on the right. Describe a goal in natural language, and it can write or edit formal project content.',
        why: 'The same work can be done by hand in the middle panels or by asking the Agent. You do not have to learn every button first.',
        example: 'You can say “Make the fork’s choice question feel more natural.” It edits the formal beat graph and shows a change summary.',
        where: 'Build and Playtest share the same right-hand panel. Expand it during playtest to ask about the current screen.'
      },
      agentChangeset: {
        term: 'Change summary',
        summary: 'After the Agent really changes the project, a needs-review list appears under that reply.',
        why: 'See what changed before you keep it, undo the whole turn, or keep talking to accept it by default.',
        example: 'A row may say the beat “beat-choose” question changed from “Which way?” to “Which way will you go?”',
        where: 'Open View changes in the right-hand chat. Locate beside a row opens the matching panel.',
        caution: 'If you press neither button and keep chatting or editing, the system treats this turn as accepted.'
      },
      materials: {
        term: 'Materials',
        summary: 'Reference text for you and the Agent. Readers never see these files in playtest.',
        why: 'You can drop a draft or idea here, but you do not have to upload anything before writing.',
        example: 'A setting excerpt or a short idea. The page can stay empty.',
        where: 'The Materials tab in Build. Upload or paste plain text.'
      },
      intent: {
        term: 'Intent',
        summary: 'A direction for yourself. It does not become playable content.',
        why: 'It keeps you and the Agent from drifting: subject, mood, and the choices you want readers to make.',
        example: '“A short fork: let the reader make one consequential choice between meadow and woods.”',
        where: 'The Intent tab in Build. Describe your creative intent in your own project.'
      },
      outline: {
        term: 'Outline',
        summary: 'A roadmap. In interactive narrative it often says what happens if the reader chooses A or B.',
        why: 'When the outline changes, later events and beat graphs usually change too.',
        example: '“Reach the fork; left leads to the meadow ending, right to the woods ending.”',
        where: 'The Outline tab in Build. Outline first or draw events first — both are fine.'
      },
      worldCard: {
        term: 'World card',
        summary: 'People, places, and other reused things, so events and beat graphs can point at one card.',
        why: 'The same character should not become two people. Playtest also uses card images as portraits and backgrounds.',
        example: 'The Walker has a portrait; the Fork has a background.',
        where: 'The World tab in Build. Characters and locations can upload or generate images.'
      },
      event: {
        term: 'Event',
        summary: 'A large stage the reader passes through, shown as one box on the event graph.',
        why: 'Without events, readers have no path. An event is larger than a single line.',
        example: '“Reach the fork” is one event; “rest in the meadow” is another.',
        where: 'The Events tab in Build, which also holds the event list, state variables, and execution verification.'
      },
      eventNetwork: {
        term: 'Event graph',
        summary: 'The outer graph. Boxes are events; lines show where a reader can go next.',
        why: 'Interactive narrative is a branching net, not chapter after chapter.',
        example: 'In the demo, the fork leads to the meadow ending and the woods ending. A lock means a state is required.',
        where: 'The Event graph tab. Click a box or a line to open the inspector.'
      },
      eventList: {
        term: 'Event list',
        summary: 'Manage events one by one and open the beat graph inside an event.',
        why: 'If you do not want to hunt on the graph, open unfinished events from the list.',
        example: 'The list shows which events already have a beat graph and which are still empty.',
        where: 'The Event list tab. Open beat graph goes inside one event.'
      },
      sceneNetwork: {
        term: 'Beat graph',
        summary: 'The inner graph of one event. Playtest mostly reads this layer.',
        why: 'The event graph is the large road. The beat graph is what you see after walking into that stage.',
        example: 'Inside the fork: arrival narration → a choice → left or right narration.',
        where: 'Open beat graph from the event list or the event inspector.'
      },
      beat: {
        term: 'Beat',
        summary: 'A short unit in the beat graph: narration, dialogue, monologue, or choice.',
        why: 'The text a reader sees on each screen is written on these beats.',
        example: 'A choice beat’s text is the question “Which way will you go?” Narration describes arriving at the fork.',
        where: 'The beat inspector. Narration, dialogue, and monologue hold text; choice options live under Leaves from here.'
      },
      choice: {
        term: 'Choice',
        summary: 'A route the reader can click. The choice beat holds the question; the options are outgoing edges.',
        why: 'Two edges to different next beats make the choice feel like it has consequences.',
        example: '“Go left, toward the meadow” and “Go right, into the woods.”',
        where: 'Leaves from here on a choice inspector, or the edge on the graph.'
      },
      stateVariable: {
        term: 'State variable',
        summary: 'The story’s notebook: it remembers earlier choices and can change later paths.',
        why: 'Later options can read it to decide whether a path is open.',
        example: 'Chosen path starts as undecided, becomes meadow after left, woods after right.',
        where: 'The State variables tab. Writes happen on beats; reads happen on edge conditions.'
      },
      variableTypes: {
        term: 'Variable types',
        summary: 'A flag is yes/no, an enum is exclusive labels, and a scalar is a bounded integer.',
        why: 'The type decides how you write and compare the value. The wrong type breaks later conditions.',
        example: 'Flag “has the key” uses set true/false. Enum Chosen path uses set meadow. Scalar stamina can use add -1.',
        where: 'The variable inspector: choose a type, allowed values, and the initial value.'
      },
      stateWrite: {
        term: 'State write',
        summary: 'When the reader passes this beat, a state variable changes.',
        why: 'Editing the definition on the Build page does not change values mid-playtest. The write does.',
        example: 'The left narration sets Chosen path to meadow. A scalar can also add, such as stamina -1.',
        where: 'State writes in the beat inspector.'
      },
      unlockCondition: {
        term: 'Unlock condition',
        summary: 'Uses current state-variable values to decide whether this path can be entered.',
        why: 'If the condition fails, the option is grayed out in playtest.',
        example: 'The event edge to the meadow ending requires Chosen path to equal meadow.',
        where: 'Event or beat-graph edge inspectors. Flags and enums use equals or not-equals; scalars can also compare.'
      },
      draftSave: {
        term: 'Draft and save',
        summary: 'Direct edits stay in the draft until you click Save.',
        why: 'Do not ask the Agent to run while a draft is unsaved, or it may overwrite what you are editing.',
        example: 'After you change an event title, a dirty badge appears. Save makes it the formal version.',
        where: 'Save and Discard draft changes on each Build page.',
        caution: 'A successful save often turns verification into “not yet verified”. That means the content changed. It is not an error.'
      },
      validation: {
        term: 'Execution verification',
        summary: 'Walks forward from the entrance along real choices and checks whether the current version can run.',
        why: 'It checks structure, references, and routes. It does not score the story.',
        example: 'The demo already passed: both endings are reachable and there is no dead end.',
        where: 'The Execution verification tab in Events. Run it after editing to check the current version for issues.'
      },
      validationStatuses: {
        term: 'Verification states',
        summary: 'Not yet verified, passed, failed, and incomplete are structural states, not quality scores.',
        why: 'After the content changes, the last result no longer applies. Run it again when you want.',
        example: '“Not yet verified” is common after a save or an Agent write. A missing beat graph file becomes incomplete.',
        where: 'The status title at the top of Execution verification.'
      },
      playtest: {
        term: 'Playtest',
        summary: 'Walk from the entrance to an ending with the current content and see what a reader would experience.',
        why: 'Build writes the structure. Playtest walks the screens. If a path fails, go back and fix it.',
        example: 'At the fork you see the question and two options. Reaching an ending event shows an ending card.',
        where: 'Switch from Build to Playtest in the middle header. A grayed-out choice usually means its condition is not met.'
      }
    },
    hints: {
      firstEmptyProjectAgent: {
        title: 'Start with one sentence',
        body: 'Tell the Agent on the right what story you want, for example a genre, mood, or a key choice. It can help you build the outline, world cards, events, and beat graphs step by step.'
      },
      firstChangeset: {
        title: 'Review the Agent’s summary first',
        body: 'Open View changes to see which events or beat graphs changed. You do not have to accept everything at once.'
      },
      firstChangesetLocate: {
        title: 'Each change can jump to the original place',
        body: 'Use Locate on the right to open that content in the workspace, so you can check and edit it in context.'
      },
      firstMaterials: {
        title: 'Materials are references for you and the Agent',
        body: 'Put drafts, excerpts, or ideas here. Readers see the story content during playtest, not these reference files.'
      },
      firstIntent: {
        title: 'Intent records the story direction',
        body: 'Write a few lines about the genre, mood, and the core choice you want readers to face. It keeps you and the Agent on track; it does not become playable content.'
      },
      firstOutline: {
        title: 'The outline plans the main routes',
        body: 'Write the main events and what happens after choice A or choice B. If the outline changes, later events and beat graphs usually need to follow.'
      },
      firstWorld: {
        title: 'World cards store reusable people and places',
        body: 'Register recurring characters and locations as cards so events and beat graphs can cite them. Character and location images also appear in playtest.'
      },
      firstEventNetwork: {
        title: 'The event graph is the outer route',
        body: 'Boxes are the large stages a reader can pass through. Lines show where they can go next. A lock means a state condition still has to be met.'
      },
      firstEventList: {
        title: 'The event list opens inner beat graphs',
        body: 'See which events already have beat graphs. From here you can generate a beat graph or open the beat graph inside one event.'
      },
      firstSceneNetwork: {
        title: 'The beat graph organizes what readers read',
        body: 'This is the narration, dialogue, choices, and connections inside one event. What playtest shows screen by screen is mainly written here.'
      },
      firstVariables: {
        title: 'State variables remember what already happened',
        body: 'This page defines variables. Values change on a beat’s state writes, and edges read them as unlock conditions.'
      },
      firstLockedChoice: {
        title: 'A grayed-out choice usually means a condition is unmet',
        body: 'Hover to see why. Return to Build, fix the write or the condition, then playtest again.'
      },
      firstSaveUnchecked: {
        title: 'Saving turns the status into “not yet verified”',
        body: 'That means the content changed, so the last verification no longer applies. Run verification again when you want.'
      },
      firstValidation: {
        title: 'Execution verification checks whether the story structure can run',
        body: 'It starts at the entrance and follows the current choices and conditions, looking for unreachable content, dead ends, missing beat graphs, and invalid references. The status only reflects structure and routes, not story quality.'
      },
      firstPlaytest: {
        title: 'Playtest follows the choices you wrote',
        body: 'An ending card appears when you reach an ending. From there you can play again or return to Build.'
      },
      firstWorldCardInspector: {
        title: 'Opening a card lets you edit its content and images',
        body: 'Worldview, character, location, faction, history, and other cards share this editor. Characters and locations also support upload or replace, one-click generation, and regeneration. Character images become playtest portraits; location images become backgrounds.'
      },
      firstEventNodeInspector: {
        title: 'An event node is an outer story stage',
        body: 'Edit its title, summary, type, characters, and locations, and manage the choices that leave from here.'
      },
      firstEventEdgeInspector: {
        title: 'An event edge is a reader-facing destination',
        body: 'It holds the player-facing text, the target event, and an optional unlock condition.'
      },
      firstSceneBeatInspector: {
        title: 'A beat is one screen the reader actually sees',
        body: 'It can be narration, dialogue, monologue, or a choice prompt, and can set location, speaker, and state writes. Choice prompts are still beats.'
      },
      firstSceneEdgeInspector: {
        title: 'A beat-graph edge connects two nodes',
        body: 'Edges from a choice prompt become reader options and can carry unlock conditions.'
      },
      firstVariableInspector: {
        title: 'Opening a variable shows how it is used',
        body: 'Set its type, initial value, and value meanings, and see where beat graphs write it and where edges read it.'
      }
    },
    steps: {
      layoutSidebar: {
        title: 'Projects',
        body: 'Use the left column to create, open, and manage projects. After you select a project, the project workspace and the Agent both work on that project. The top button can collapse or expand this column.'
      },
      layoutBuild: {
        title: 'Project workspace',
        body: 'The middle column is the project workspace. Use it to inspect, edit, analyze, and play the project: materials, story planning, world cards, events, beat graphs, and playtest.'
      },
      layoutAgent: {
        title: 'Agent workspace',
        body: 'The right column is the Agent workspace. Describe a goal, ask about the current project, or let the Agent create and edit content. Its progress, results, and project changes appear here. The top button can collapse or expand this panel.'
      },
      agentInput: {
        title: 'Enter a request',
        body: 'Type the work you want the Agent to do. You can state a goal and add the object, scope, and constraints, for example “Make the fork’s choice question clearer, so players know what to do.”'
      },
      agentExample: {
        title: 'The user request',
        body: 'This request names both the object—the fork’s choice question—and the intended effect: clearer wording and a more obvious action. More specific requests are easier to check.'
      },
      agentResponse: {
        title: 'The Agent’s result',
        body: 'After the Agent finishes, its reply explains what it did, what it changed, and whether anything still needs confirmation. If it edited the project, a change record also appears under the reply.'
      },
      agentChangesetToggle: {
        title: 'Open the change details',
        body: 'The collapsed row already shows how many places changed and whether they still need review. Click “View changes” to see each change.'
      },
      agentChangesetDetails: {
        title: 'Review this turn’s changes',
        body: 'This list shows the objects that changed and the before/after text. You can keep the whole turn or undo it. If you continue the conversation or start editing yourself, the system treats this turn as accepted.'
      },
      agentLocate: {
        title: 'Locate the change',
        body: 'Each change has a Locate button on the right. Click it to open that content in the project workspace, so you can inspect and edit it in context.'
      },
      checkModifiedContent: {
        title: 'Inspect the changed content',
        body: 'The change record on the right and the content location in the workspace refer to the same sentence. You can inspect or edit it in context.'
      },
      playtestOpen: {
        title: 'Open Playtest',
        body: 'Use the top switch to move between Build and Playtest. Build is for viewing and editing the project; click Playtest to experience the story as a reader.'
      },
      playtestOpening: {
        title: 'Start from the beginning',
        body: 'Playtest starts at the beginning of the story. Narration, dialogue, and choices move the story forward.'
      },
      playtestResult: {
        title: 'Choose as a reader',
        body: 'After the story reaches the fork, you see the question and the available paths, and can check whether they match what you intended.'
      },
      playtestAgent: {
        title: 'Ask with the current moment attached',
        body: 'During playtest, the Agent can attach the current event, beat, and run state. Ask about this screen directly, for example “Can this question be clearer?” or “Why is this choice unavailable?”, without restating where you are.'
      },
      finishNormal: {
        title: 'Open concept help whenever you need it',
        body: 'This tour only covers the basic collaboration loop. Open concept help whenever you need events, beat graphs, state variables, or verification. Local question marks open the matching entry. You can now create or open your own project.'
      }
    }
  }
};
