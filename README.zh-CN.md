# NarrativeSteward

[![arXiv Paper](docs/images/arxiv-badge.svg)](https://arxiv.org/abs/2609.39333)

<a href="README.md"><kbd>English</kbd></a> · <a href="README.zh-CN.md"><kbd>简体中文</kbd></a>

**一个支持 AI 协作创作与试玩的交互叙事工作空间。**

将故事想法和参考素材整理为世界卡片、相互关联的事件与分支场景。你可以与 AI 助手共同创作，检查每次修改，再通过试玩观察玩家选择如何影响后续路径。界面与内置教程均支持中英文。

论文：[NarrativeSteward: Coordinating Delegation, Guidance, and Verification in Agent-Assisted Interactive Narrative Authoring](https://arxiv.org/abs/2609.39333)

## 组织和编辑故事

通过事件图组织故事结构。选中事件后，可以编辑概要、关联角色与地点，再进入事件内部编排对话和选择。AI 助手与这些编辑器位于同一个工作空间中。

![The Fork 示例的事件图、事件编辑面板与助手对话](docs/images/workspace.png)

*The Fork（岔路口）示例：一次选择通向两个结局，后续路径由玩家的选择解锁。*

## 检查修改，继续创作

用自然语言提出修改要求，再检查实际保存的变化。你可以对比修改前后的内容、定位到对应的故事片段，并选择保留或撤销这一轮修改。之后既可以直接编辑，也可以继续向助手提出要求。

![查看场景修改前后的内容，以及定位、保留和撤销操作](docs/images/change-review.png)

*示例修改让岔路口的选择问句更清楚，同时保留已有分支。*

## 检查并试玩故事

检查故事结构与受状态影响的路径，再从玩家视角实际体验。玩家选择会更新状态，决定后续哪些路线可以进入。你也可以将试玩中的选项引用到对话中，与助手讨论。

![试玩岔路口故事，查看可进入和被锁定的路径](docs/images/playtest.png)

*选择树林后，通往树林的路线开放，草地路线仍然锁定。截图使用英文示例，应用也支持中文界面与教程。*

## 本地运行

需要 Python 3.12 和 Node.js 24 LTS（24.21.0 或更高的 24.x 版本）。仓库提供 `.python-version` 和 `.nvmrc`；使用 nvm 时，可在仓库根目录执行 `nvm install` 和 `nvm use`。然后创建独立的 Python 环境：

```bash
python3.12 -m venv .venv
source .venv/bin/activate
python -m pip install -r code/backend/requirements.lock
python -m pip install --no-build-isolation -c code/backend/requirements.lock -e './code/backend[api]'
cp code/backend/.env.example code/backend/.env
```

### 配置 `.env`

复制 [`.env.example`](code/backend/.env.example) 后，编辑 `code/backend/.env`。以 `#` 开头的行是注释，需要去掉 `#` 才会生效。下文的默认值在变量**未设置**时使用；不用的配置保持注释即可，不要改成空值。修改后重启后端。终端中已导出的环境变量优先于 `.env` 中的同名配置。

#### 对话模型

创作助手需要配置以下三项：

```dotenv
OPENAI_API_KEY=your_api_key
OPENAI_BASE_URL=your_base_url
OPENAI_MODEL=your_model_name
```

| 配置项 | 应填写的内容 |
| --- | --- |
| `OPENAI_API_KEY` | 服务商提供的 API Key 或 Token。 |
| `OPENAI_BASE_URL` | 完整的 API 基础地址，例如 `https://your-gateway/v1`，不要再拼接 `/chat/completions`。 |
| `OPENAI_MODEL` | 服务商提供的模型标识。模型与接口需要支持流式输出和工具调用。 |

对话模型和地址没有默认值。不配置这三项，也可以浏览教程、手动编辑项目、检查故事结构与状态，并试玩已有故事。

#### 图片生成（可选）

生图功能为世界卡片生成**角色立绘**和**地点背景**，这些配图也会用于试玩。卡片上的生图按钮与助手的生图工具使用同一套配置。不配置生图密钥，也可以使用对话助手、上传已有图片和试玩。

生图服务需要单独配置，即使它与对话使用相同的密钥和网关：

```dotenv
IMAGE_API_KEY=your_image_api_key
IMAGE_BASE_URL=your_image_base_url
IMAGE_MODEL=your_image_model_name
IMAGE_SIZE=1024x1024
```

| 配置项 | 未设置时的行为 |
| --- | --- |
| `IMAGE_API_KEY` | 无法生成图片，不会自动复用对话密钥。 |
| `IMAGE_BASE_URL` | SDK 会先读取 `OPENAI_BASE_URL`，再回退到 `https://api.openai.com/v1`。**建议明确填写**目标生图服务地址，避免用错服务。填写 API 基础地址，不要拼接 `/images/generations`。 |
| `IMAGE_MODEL` | 使用项目默认值 `gpt-image-2`。请按生图服务商实际提供的模型标识配置。 |
| `IMAGE_SIZE` | 使用 `1024x1024`，含义是宽 × 高，单位为像素。支持的尺寸取决于所选模型。 |

服务需要支持 OpenAI 兼容的 Images 生图接口，接受 PNG 输出，并返回 Base64 图片数据（`b64_json`）。仅支持对话接口或仅返回图片 URL 的服务，无法直接用于当前生图流程。

**角色与地点的独立配置**可以在同一生图服务下分别选择模型、尺寸与背景模式：

| 用途 | 角色立绘 | 地点背景 | 未设置时的回退规则 |
| --- | --- | --- | --- |
| 模型 | `IMAGE_CHARACTER_MODEL` | `IMAGE_LOCATION_MODEL` | 先用 `IMAGE_MODEL`，再用 `gpt-image-2` |
| 尺寸 | `IMAGE_CHARACTER_SIZE` | `IMAGE_LOCATION_SIZE` | 先用 `IMAGE_SIZE`，再用 `1024x1024` |
| 背景 | `IMAGE_CHARACTER_BACKGROUND` | `IMAGE_LOCATION_BACKGROUND` | 不发送背景参数，由模型决定。 |

这些配置分别生效。例如，只设置 `IMAGE_CHARACTER_SIZE`，就只改变角色图片尺寸，模型仍使用通用生图配置。所有生图请求仍共用 `IMAGE_API_KEY` 和 `IMAGE_BASE_URL`。

如果服务商支持以下模型和参数，可以这样配置透明竖版角色立绘与不透明横版地点背景：

```dotenv
IMAGE_CHARACTER_MODEL=gpt-image-1
IMAGE_CHARACTER_SIZE=1024x1536
IMAGE_CHARACTER_BACKGROUND=transparent

IMAGE_LOCATION_MODEL=gpt-image-2
IMAGE_LOCATION_SIZE=1536x1024
IMAGE_LOCATION_BACKGROUND=opaque
```

背景参数可选 `transparent`（透明）、`opaque`（不透明）或 `auto`（由模型选择）。角色图片不会自动启用透明背景，需要选择支持该能力的模型，并设置 `IMAGE_CHARACTER_BACKGROUND=transparent`。当前实现会拒绝以 `gpt-image-2` 开头的模型名称与 `transparent` 的组合。如果服务商不支持示例中的模型或尺寸，请替换为它实际支持的值；不支持背景参数时，保持对应配置为注释状态。

对话和生图请求都可能产生相应服务商的费用。

<details>
<summary>其他参数及默认值</summary>

| 配置项 | 默认值 | 含义 |
| --- | --- | --- |
| `LLM_MAX_TOKENS` | `8192` | 单次对话模型回复的最大输出 token 数，不是输入上下文上限。应在所选模型支持的范围内设置。 |
| `LLM_TIMEOUT` | `180` | 对话请求超时，单位为秒；不是整个创作任务的总时限。 |
| `LLM_MAX_RETRIES` | `2` | 对符合重试条件的临时对话接口错误自动重试的次数。设为 `0` 可关闭重试。 |
| `IMAGE_TIMEOUT` | `180` | 生图请求超时，单位为秒。服务生成较慢时可适当增大。 |
| `IMAGE_MAX_RETRIES` | `2` | 对符合重试条件的临时生图接口错误自动重试的次数。设为 `0` 可关闭重试。 |
| `NARRATIVE_FORGE_WORKSPACE` | 仓库根目录的 `workspace/` | 用户项目的保存位置。建议用绝对路径指定其他目录。 |

</details>

### 启动应用

在一个终端中使用上述 Python 环境启动后端：

```bash
cd code/backend
python -m uvicorn narrative_forge.api.app:app --host 127.0.0.1 --port 8000 --workers 1
```

在另一个终端中启动前端：

```bash
cd code/frontend
npm ci
npm run dev
```

打开 <http://127.0.0.1:8080>。

项目保存在仓库根目录的 `workspace/` 中。可通过 `NARRATIVE_FORGE_WORKSPACE` 指定其他存储目录。

## 项目结构

- `code/backend`：Python 后端与创作助手。
- `code/frontend`：React 编辑器与试玩界面。
- [docs/DESIGN.md](docs/DESIGN.md)：应用架构与运行约束。
- [docs/CHANGELOG.md](docs/CHANGELOG.md)：版本说明。

## 引用

如果你在研究中使用 NarrativeSteward，请引用我们的论文：

```bibtex
@article{wang2026narrativesteward,
  title   = {{NarrativeSteward}: Coordinating Delegation, Guidance, and Verification in Agent-Assisted Interactive Narrative Authoring},
  author  = {Wang, Wenjin and Lei, Jiazhen and Sha, Yuxin and
             Xi, Nuwa and Zhao, Meng and Yin, Xingxi and
             Liu, Qi and Shen, Yuliang and Sun, Zixun},
  journal = {arXiv preprint arXiv:2609.39333},
  year    = {2026}
}
```
