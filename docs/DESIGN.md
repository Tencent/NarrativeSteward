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

## Portable project export

The project toolbar exports saved story data and referenced images as a ZIP containing a bundled `player.html`, generated `story.js` and a `project/` directory. Version 1 manifests use `format: narrativesteward-project`, `version: 1`, a title, world/event/scene file mappings and an image list. Authoring chats, source materials, revision history, logs and private project metadata are excluded. Incomplete scenes, invalid references and missing referenced images prevent export. Export takes a project lock; unsaved edits and active operations disable the UI action.

The offline HTML player loads the exporter-generated `story.js` beside it as a classic script, and referenced images from `project/assets/` using relative URLs. Opening `player.html` shows the story's start screen without a folder picker, network connection or local server. Keep the extracted directory together. JSON files remain in `project/`; re-export after editing the source, since playback uses the generated snapshot. The exporter serializes validated data and never copies arbitrary project scripts. Story text is rendered as text. The start screen has no license button or dialog. Project and dependency notices remain embedded in a non-visible HTML template; the package README focuses on opening and playing the story. Story and artwork rights remain independent.

The editor and offline player share the same choice, state and undo engine. The standalone game uses one compact toolbar and a viewport-filling stage. Dialogue and action regions keep stable geometry as text appears and choices become available. Long text paginates; up to three choices share each row/page, with full text available for truncated labels. Text reveals progressively before choices appear, with an instant-text preference and reduced-motion support. Exceptionally long choices can be read in a dialog before selection. Space reads the next text page, then advances a single continuation; it never chooses a branch. Main-row digits 1–9 select numbered choices on the visible option page, including unavailable positions in the numbering. Buttons show their shortcuts. Held keys, modifier combinations, editable fields and open dialogs do not trigger background gameplay. Long-option shortcuts open the same reading dialog as a click.

Story progress displays the complete event topology as an exploration map. Locked events show question marks instead of names or images. Visited events show their names and thumbnails from scenes actually displayed; the current event is highlighted, while normally exited events and reached endings are marked complete. The map centers on the current event at readable zoom after opening; current-event and full-map controls allow navigation. Layout follows the actual graph, including branches and merges. Clicking an unlocked event opens its already-read excerpts; locked events do not reveal details. Nodes on the current route also offer replay from their saved entry state, truncating the later route without discarding discoveries. Previously explored nodes outside the current route are review-only.

Exploration knowledge accumulates separately from the active play history for as long as the player page remains open. Undo and restart preserve unlocked nodes and read prefixes, so exploring another branch reveals both paths. Only edges taken in the active route are highlighted; other edges stay muted and dashed. This is not a save across page closure. Current state values remain in a separate tab. The dialog closes with its close button, Escape or backdrop and restores focus.

The source repository and Python distributions exclude the generated `resources/player.html`. Users install frontend dependencies with `npm ci` and generate the player locally with `npm run build:player`. Both `npm run dev` (through `predev`) and `npm run build` generate it before starting or building the editor. The exporter uses this local artifact; if it is missing, export reports the build command rather than installing dependencies or building inside the backend.

Data-only example ZIPs contain `story.js`, `project/` data and referenced images, and `README.md`; they do not include the player or bundled third-party libraries. Users copy their locally built `player.html` next to `story.js`, then open it in a desktop browser. This path requires Node.js for the initial build, but no Python, running server or model credentials. The same player can be reused with each compatible example. Full workspace imports and authoring remain a separate platform workflow.

Character cards support optional `image_display`: `portrait` (default), `object` (smaller artwork) or `scene` (full-scene artwork during speech). Export preserves the setting; the shared visual resolver also applies it in the editor. Unavailable choices show rule-derived requirements and current values. State values use authored descriptions, with localized boolean and unset fallbacks.

## Repository overview

Both README languages place an inline video player, with no cover-image link to another page, immediately before four playback steps: build the player, download a story-data ZIP, extract it and copy the player, then open the game. The instructions stay in the README without a separate example guide. The arXiv badge and citation remain the paper entry points.
