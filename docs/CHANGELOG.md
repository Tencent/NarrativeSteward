# Changelog

## Unreleased

Initial release:

- Local, bilingual workspace for editing story materials, intent, outlines, world cards, event networks and scene graphs.
- Agent dialogue, streamed execution details, change previews, keep/revert and stop/recovery.
- Deterministic structure and state checks, playtesting and project persistence.
- Read-only Chinese and English tutorials that work without model credentials.
- Help and read-only messages distinguish tutorial examples from editable user projects.
- MIT License.
- Configurable OpenAI-compatible chat endpoint, API key and model, with streaming and tool calling.

## Project export and offline player

- Export saved story data and referenced images from the project toolbar, with a bundled standalone HTML player.
- Open the player locally and select an extracted project folder to play without a server or network. English/Chinese controls, undo, restart, endings and fullscreen are supported.
- Validate required scenes, graph references and image paths before export; exclude authoring chats, materials, history and private metadata.

## Direct-open story player

- Open an extracted story and start playing immediately: generated story data and adjacent images load automatically, without a folder picker or local server.
- Combine game controls into one toolbar and fit gameplay to the window. Paginate long text and choice lists; exceptionally long choices can be read in full before selection.
- Review this run's visited events in a dismissible, zoomable story-progress map. Click events to read previously displayed text and choices; undo and restart keep the map aligned with the active run. Unread text and unvisited routes stay hidden.

## Exploration map and compact choices

- Show the full event graph as an exploration map, centered on the current event when opened. Discovered events have scene thumbnails and completion markers; unknown events hide their names and artwork behind question marks.
- Keep discoveries across undo and restart within the open player session. Alternative explored branches remain visible and their read excerpts can be reviewed without changing the current route.
- Size dialogue and choice panels to their actual contents, removing oversized empty backplates while preserving pagination for long text and choice lists.


## Offline player keyboard controls

- Use Space to read the next text page or advance a single continuation, and main-row digits 1–9 to select visible numbered choices.
- Preserve reading and availability checks; open dialogs, editable fields, modifier combinations and held keys do not advance background gameplay.

## Offline player presentation and route replay

- Export character artwork modes for portraits, small objects and scene close-ups, preserving compatibility with older cards that omit the setting.
- Reveal text before choices, keep dialogue/action regions stable, paginate long content and provide an instant-text preference and reduced-motion support.
- Explain unavailable choices from their actual conditions and show localized or story-defined state values.
- Highlight only the current route in the exploration map. Replay current-route events from their entry state while retaining discoveries; review other explored routes without changing play state.
- Rebuild the bundled player with the frontend build so exported stories run offline without a server or API credentials.


## Offline player start screen

- Simplify the start screen by removing the license button and dialog, and keep exported instructions focused on opening and playing the story. Embedded project and dependency notices remain included in the HTML.


## Build the offline player locally

- Distribute player source and build scripts; exclude the generated HTML from the source tree and Python packages.
- Build the player automatically before starting the development editor; keep standalone and full build commands available. Missing-player export errors include the build directory and commands.
- Document data-only example packages and a Node-only playback path, separate from full platform setup.


## Showcase and example overview

- Put the Chinese showcase video and linked cover near the top of both README languages, followed by the three-example overview and playback guide.
- Keep the arXiv badge and citation while removing the duplicate standalone paper link.


## Quick playback instructions

- Place four playback steps directly below the showcase video, with build commands and data-package names. Remove the separate example guide and duplicate playback explanations.


## Inline showcase preview

- Replace the linked showcase cover with an inline video element above the four-step playback guide.


## GitHub inline video

- Use GitHub video attachments to play the showcase directly in both README languages.
