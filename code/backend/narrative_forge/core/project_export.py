"""Portable story packages with an automatically loaded playback snapshot."""
from __future__ import annotations

import io
import json
from pathlib import Path, PurePosixPath
import zipfile

from .validation import validate_project_draft
from .models import WorldSetting, EventGraph, SceneGraph

FORMAT = 'narrativesteward-project'
VERSION = 1
MAX_ASSET_BYTES = 256 * 1024 * 1024


def build_project_export(store, project_id: str) -> bytes:
    """Export only story data and referenced local images, never workspace history."""
    meta = store.load_meta(project_id)
    world = store.get_data(project_id, 'world')
    events = store.get_data(project_id, 'events')
    if not world or not events or not events.get('nodes'):
        raise ValueError('请先完成设定、事件和情节 / Complete the story before exporting.')
    world = WorldSetting.model_validate(world).model_dump(mode='json')
    events = EventGraph.model_validate(events).model_dump(mode='json')
    scenes = {}
    for node in events['nodes']:
        scene = store.get_scene(project_id, node['id'])
        if not scene or not scene.get('beats'):
            raise ValueError(f"缺少情节 / Missing scene: {node.get('title', node['id'])}")
        scenes[node['id']] = SceneGraph.model_validate(scene).model_dump(mode='json')
    issues = validate_project_draft(world_data=world, events_data=events, scenes=scenes)
    if issues:
        raise ValueError('项目需要修复 / Invalid story: ' + '; '.join(i.message for i in issues[:5]))
    root = store.project_path(project_id).resolve()
    assets = {}
    total = 0
    for cards in world.values():
        for card in cards:
            name = card.get('image')
            if not name or name in assets:
                continue
            path = PurePosixPath(name)
            if (path.is_absolute() or '..' in path.parts or '\\' in name
                    or len(path.parts) != 2 or path.parts[0] != 'assets'
                    or path.suffix.lower() not in {'.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif'}):
                raise ValueError(f'非法图片路径 / Invalid image path: {name}')
            source = root / name
            if not source.is_file() or source.is_symlink() or not source.resolve().is_relative_to(root):
                raise ValueError(f'图片丢失或越界 / Missing or unsafe image: {name}')
            total += source.stat().st_size
            if total > MAX_ASSET_BYTES:
                raise ValueError('图片总量超过 256 MiB / Images exceed 256 MiB.')
            assets[name] = source.read_bytes()
    player = Path(__file__).resolve().parents[1] / 'resources/player.html'
    if not player.is_file():
        raise ValueError('播放器尚未构建，请在 code/frontend 运行 npm ci 和 npm run build:player。 / Player not built. Run npm ci and npm run build:player in code/frontend.')
    mapping = {event_id: f'scenes/{index:04d}.json' for index, event_id in enumerate(scenes)}
    manifest = dict(format=FORMAT, version=VERSION, title=meta.name,
                    files=dict(world='world.json', events='events.json', scenes=mapping),
                    assets=sorted(assets))
    # JSON.parse of a JSON string prevents object-literal __proto__ semantics and
    # keeps quotes, line separators and script-looking story text inert.
    files = {'manifest.json': manifest, 'world.json': world, 'events.json': events}
    files.update({mapping[event_id]: scene for event_id, scene in scenes.items()})
    bundle = json.dumps({'manifest': manifest, 'files': files}, ensure_ascii=True)
    story_script = 'window.NARRATIVE_STEWARD_STORY = JSON.parse(' + json.dumps(bundle, ensure_ascii=True) + ');\n'
    output = io.BytesIO()
    with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        def data(name, value):
            archive.writestr('project/' + name, json.dumps(value, ensure_ascii=False, indent=2) + '\n')
        data('manifest.json', manifest)
        data('world.json', world)
        data('events.json', events)
        for event_id, scene in scenes.items():
            data(mapping[event_id], scene)
        for name, raw in assets.items():
            archive.writestr('project/' + name, raw)
        archive.writestr('player.html', player.read_bytes())
        archive.writestr('story.js', story_script)
        archive.writestr('README.txt',
            '解压全部文件，双击 player.html，点击“开始游戏”。保持 story.js 和 project 文件夹在旁边。\n'
            '全部加载在本机完成，不需要服务、网络或 API 密钥。修改源项目后请重新导出；播放读取 story.js 快照。\n'
            '本包包含故事设定、事件、情节与引用图片，不包含创作聊天、材料库或历史记录。\n'
            '\n'
            'Extract all files, open player.html and click Start story. Keep story.js and project beside it.\n'
            'No server, network or API key is needed. Re-export after source edits; playback uses the story.js snapshot.\n'
            'The package contains story data and images, not authoring chats, materials or history.\n')
    return output.getvalue()
