export function resolveStepTargets(step) {
  if (Array.isArray(step?.targets) && step.targets.length) {
    return step.targets.map(item => typeof item === 'string' ? {
      target: item
    } : item).filter(item => item?.target);
  }
  if (step?.target) return [{
    target: step.target
  }];
  return [];
}
const BUILD_CHAT = {
  board: 'build',
  tab: 'materials',
  chatPanel: 'expanded'
};
const BUILD_CHECKED = {
  board: 'build',
  tab: 'events',
  eventsSubtab: 'content',
  openScene: 'ev-fork',
  sceneBeatId: 'beat-choose',
  chatPanel: 'expanded'
};
export const QUICK_START_STEPS = [{
  id: 'layout-sidebar',
  title: '项目管理',
  body: ['左侧用于创建、选择和管理项目。选择项目后，中间的项目工作区和右侧 Agent 都会围绕当前项目工作。需要时，可以用顶部按钮收起或重新展开左侧面板。'],
  target: 'sidebar',
  reveal: BUILD_CHAT,
  modes: ['normal']
}, {
  id: 'layout-build',
  title: '项目工作区',
  body: ['中间是项目工作区，用于对项目内容进行结构化的查看、编辑、分析与体验。你可以在这里管理素材、故事规划、世界设定、事件和具体情节，也可以切换到试玩，检查读者实际看到的故事。'],
  target: 'build',
  reveal: BUILD_CHAT,
  modes: ['normal']
}, {
  id: 'layout-agent',
  title: 'Agent 协作区',
  body: ['右侧是 Agent 协作区。你可以用自然语言说明创作目标、询问当前项目，或让 Agent 创建和修改内容；Agent 的执行过程、处理结果和项目改动都会显示在这里。需要时，可以用顶部按钮收起或重新展开该面板。'],
  target: 'agent',
  reveal: BUILD_CHAT,
  modes: ['normal']
}, {
  id: 'agent-input',
  title: '输入要求',
  body: ['在这里输入希望 Agent 完成的工作。要求可以直接描述目标，也可以补充需要处理的对象、范围和限制，例如“把岔路口的选择问句改得更自然，让玩家一眼知道要做什么”。'],
  target: 'agent-input',
  reveal: BUILD_CHAT,
  modes: ['normal']
}, {
  id: 'agent-example',
  title: '用户请求',
  body: ['这条请求同时说明了处理对象——岔路口的选择问句，以及预期效果——表达更自然、意图更明确。要求越具体，Agent 的结果就越容易检查。'],
  target: 'agent-example',
  reveal: BUILD_CHAT,
  modes: ['normal']
}, {
  id: 'agent-response',
  title: 'Agent 处理结果',
  body: ['Agent 完成工作后，会在回复中说明处理结果，包括完成了什么、影响了哪些内容，以及是否还有需要确认的问题。对于修改项目内容的请求，回复下方还会提供本轮修改记录。'],
  target: 'agent-response',
  reveal: BUILD_CHAT,
  modes: ['normal']
}, {
  id: 'agent-changeset-toggle',
  title: '展开修改细节',
  body: ['折叠行已经显示修改数量和处理状态。点击「查看细节」后，才会展示每一处具体改动。'],
  target: 'agent-changeset-toggle',
  reveal: {
    ...BUILD_CHAT,
    changesetExpanded: 'collapsed'
  },
  modes: ['normal']
}, {
  id: 'agent-changeset-details',
  title: '核对本轮修改',
  body: ['这里列出本轮改动涉及的对象和修改前后内容，便于确认实际发生了什么。你可以保留整轮修改，也可以整轮撤销；如果继续对话或开始手动编辑，系统会将这轮修改视为已接受。'],
  target: 'agent-changeset',
  reveal: {
    ...BUILD_CHAT,
    changesetExpanded: 'expanded'
  },
  modes: ['normal']
}, {
  id: 'agent-locate',
  title: '定位修改',
  body: ['每条修改右侧都有「定位」按钮。点击后，项目工作区会打开这处内容，便于结合上下文检查和编辑。'],
  target: 'agent-locate-first',
  reveal: {
    ...BUILD_CHAT,
    changesetExpanded: 'expanded'
  },
  modes: ['normal']
}, {
  id: 'check-modified-content',
  title: '检查修改内容',
  body: ['右侧修改记录和中间内容位置对应同一句。可以结合上下文继续检查，也可以在这里手动编辑。'],
  targets: [{
    target: 'agent-change-detail-first',
    labelKey: 'help.overlay.changeRecord'
  }, {
    target: 'scene-content-field',
    labelKey: 'help.overlay.contentLocation'
  }],
  reveal: {
    ...BUILD_CHECKED,
    changesetExpanded: 'expanded'
  },
  modes: ['normal']
}, {
  id: 'playtest-open',
  title: '打开试玩',
  body: ['顶部可以在「构建」和「试玩」之间切换。「构建」用于查看和编辑项目内容；点击「试玩」可以从读者视角体验故事。'],
  targets: [{
    target: 'build-tab'
  }, {
    target: 'playtest-tab'
  }],
  reveal: BUILD_CHECKED,
  modes: ['normal']
}, {
  id: 'playtest-opening',
  title: '从故事开头开始',
  body: ['试玩从故事开头开始。旁白、对话和选择会推动故事前进。'],
  target: 'playtest-stage',
  reveal: {
    board: 'playtest',
    playtestTarget: 'start',
    chatPanel: 'expanded',
    changesetExpanded: 'collapsed'
  },
  modes: ['normal']
}, {
  id: 'playtest-result',
  title: '以读者视角做选择',
  body: ['推进到岔路口后，可以看到问句与可选路径，并确认它们是否符合预期。'],
  target: 'playtest-choices',
  reveal: {
    board: 'playtest',
    playtestTarget: 'choices',
    chatPanel: 'expanded'
  },
  modes: ['normal']
}, {
  id: 'playtest-agent',
  title: '结合当前情景询问',
  body: ['试玩时，Agent 可以附带当前事件、情节和本局状态。你可以直接询问当前画面，例如“这个问句还能更自然吗”或“为什么这个选项无法选择”，不必重新描述所在位置。'],
  target: 'playtest-context',
  reveal: {
    board: 'playtest',
    playtestTarget: 'choices',
    chatPanel: 'expanded'
  },
  modes: ['normal']
}, {
  id: 'finish-normal',
  title: '随时查看概念说明',
  body: ['快速上手只介绍最基本的协作流程。需要了解事件、情节、状态变量或检测等概念时，可以随时打开概念说明；界面中的局部问号会直接打开对应内容。现在可以创建或打开自己的项目开始创作。'],
  target: 'concept-help',
  reveal: BUILD_CHAT,
  modes: ['normal']
}];
const STEP_COPY_KEYS = {
  'layout-sidebar': 'layoutSidebar',
  'layout-build': 'layoutBuild',
  'layout-agent': 'layoutAgent',
  'agent-input': 'agentInput',
  'agent-example': 'agentExample',
  'agent-response': 'agentResponse',
  'agent-changeset-toggle': 'agentChangesetToggle',
  'agent-changeset-details': 'agentChangesetDetails',
  'agent-locate': 'agentLocate',
  'check-modified-content': 'checkModifiedContent',
  'playtest-open': 'playtestOpen',
  'playtest-opening': 'playtestOpening',
  'playtest-result': 'playtestResult',
  'playtest-agent': 'playtestAgent',
  'finish-normal': 'finishNormal'
};
export function stepsForMode(mode) {
  return QUICK_START_STEPS.filter(step => step.modes.includes(mode));
}
export function localizedStepsForMode(mode, t) {
  return stepsForMode(mode).map(step => {
    const mapped = STEP_COPY_KEYS[step.id];
    const copyKey = typeof mapped === 'string' ? mapped : mapped?.[mode];
    if (!copyKey) return step;
    const title = t(`help.steps.${copyKey}.title`);
    const first = t(`help.steps.${copyKey}.body.0`);
    const second = t(`help.steps.${copyKey}.body.1`);
    const third = t(`help.steps.${copyKey}.body.2`);
    const bodies = [first, second, third].filter(item => item && !item.startsWith('help.steps.'));
    const single = t(`help.steps.${copyKey}.body`);
    const body = bodies.length > 1 ? bodies : bodies[0] || (single.startsWith('help.steps.') ? step.body : single);
    return {
      ...step,
      title: title.startsWith('help.steps.') ? step.title : title,
      body
    };
  });
}
