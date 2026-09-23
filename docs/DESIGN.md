# NarrativeSteward architecture

NarrativeSteward is a local, bilingual application for authoring and playtesting interactive stories.

## Components

- `code/frontend`: a React/Vite editor for story materials, graphs, agent dialogue, diagnostics and playtesting. During development, Vite proxies `/api` requests to the backend.
- `code/backend`: a FastAPI service and Python core in the `narrative_forge` namespace. The backend manages project storage, the authoring agent, validation, revisions and playtest operations.

## Projects and tutorials

A project contains source materials, authoring intent, an outline, world cards, an event network and per-event scene graphs. Projects also retain dialogue history, execution traces and version history.

User projects are stored in a local workspace, configured with `NARRATIVE_FORGE_WORKSPACE` and defaulting to the repository's `workspace/` directory. Chinese and English tutorials are bundled as read-only package resources. Tutorials, manual editing and deterministic validation work without model credentials.

## Authoring and playtesting

The authoring agent streams dialogue and execution details. Proposed changes are presented as immutable previews, with keep/revert controls and support for stopping and recovering agent turns. Model and image providers use locally configured credentials.

The authoring agent uses an OpenAI-compatible chat API through `langchain-openai`. Users explicitly configure `OPENAI_API_KEY`, `OPENAI_BASE_URL` and `OPENAI_MODEL`; there is no default chat model or endpoint. The chosen endpoint and model must support streaming and tool calling. Image generation uses its separate `IMAGE_*` configuration.

Deterministic checks validate story structure and state-dependent paths. Diagnostics help authors locate problems, while playtesting lets them navigate the story and discuss it using the current playtest context.

The offline command `python -m narrative_forge.analysis.state_validation <project_id>` runs state validation on a saved project. Scalar state variables use bounded integers, enforced when saving. Regression tests also compare state propagation against an exhaustive reference algorithm.

## Runtime constraints

The application is intended for a trusted local user and has no account authentication. Default listeners use loopback. The backend runs with one worker because locks, active agent sessions and the event bus are held in memory.

Python 3.12 and Node.js 24 LTS are the supported runtime baseline. Dependency lockfiles define the installation versions; installation and startup instructions are in the [README](../README.md).
