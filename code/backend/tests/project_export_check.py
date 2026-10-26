"""Offline regression for portable exports, exclusions and unsafe asset references."""
from __future__ import annotations
import asyncio
import copy
import io
import json
import os
from pathlib import Path
import tempfile
import zipfile


def main():
    with tempfile.TemporaryDirectory() as tmp:
        os.environ['NARRATIVE_FORGE_WORKSPACE'] = tmp
        os.environ['NARRATIVE_FORGE_ENV_FILE'] = '/dev/null'
        from fastapi.testclient import TestClient
        from narrative_forge.api.app import create_app
        app = create_app()
        store = app.state.store
        project = store.create_project('Export check')
        pid = project.id
        world = {'locations': [{'id': 'room', 'name': 'Room'}],
                 'characters': [{'id': 'relic', 'name': 'Relic', 'image_display': 'object'},
                                {'id': 'bell', 'name': 'Bell', 'image_display': 'scene'},
                                {'id': 'person', 'name': 'Person'}]}
        events = {'nodes': [{'id': 'end', 'title': 'End', 'type': 'ending'}], 'edges': [], 'state_variables': []}
        scene = {'event_id': 'end', 'beats': [{'id': 'b', 'kind': 'narration', 'content': '<script>must remain text</script>', 'location': 'room'}], 'edges': []}
        store.set_data(pid, 'world', world)
        store.set_data(pid, 'events', events)
        store.set_scene(pid, 'end', scene)
        root = store.project_path(pid)
        for name in ['history.json', '.env', 'private-note.txt']:
            (root / name).write_text('PRIVATE_SENTINEL_DO_NOT_EXPORT')
        store.add_material(pid, 'notes.txt', 'PRIVATE_SENTINEL_DO_NOT_EXPORT')
        client = TestClient(app)
        # A source checkout has no prebuilt HTML until the local frontend build.
        from unittest.mock import patch
        with patch('narrative_forge.core.project_export.__file__',
                   str(Path(tmp) / 'source/narrative_forge/core/project_export.py')):
            missing = client.get(f'/api/projects/{pid}/export')
            assert missing.status_code == 422, missing.text
            assert 'code/frontend' in missing.text and 'npm run build:player' in missing.text
        response = client.get(f'/api/projects/{pid}/export')
        assert response.status_code == 200, response.text
        assert response.headers['content-type'] == 'application/zip'
        with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
            assert set(archive.namelist()) == {'player.html', 'story.js', 'README.txt', 'project/manifest.json', 'project/world.json', 'project/events.json', 'project/scenes/0000.json'}
            for name in archive.namelist():
                assert b'PRIVATE_SENTINEL' not in archive.read(name)
            manifest = json.loads(archive.read('project/manifest.json'))
            assert manifest['version'] == 1
            script = archive.read('story.js').decode()
            payload = json.loads(json.loads(script.removeprefix('window.NARRATIVE_STEWARD_STORY = JSON.parse(').removesuffix(');\n')))
            assert payload['files']['scenes/0000.json']['beats'][0]['content'] == scene['beats'][0]['content']
            assert payload['files']['events.json'] == json.loads(archive.read('project/events.json'))
            assert payload['manifest'] == manifest
            cards = payload['files']['world.json']['characters']
            assert [c['image_display'] for c in cards] == ['object', 'scene', 'portrait']
            assert payload['files']['world.json'] == json.loads(archive.read('project/world.json'))
            assert 'connect-src' in archive.read('player.html').decode()
        assert not app.state.locks.is_busy(pid)
        asyncio.run(app.state.locks.acquire(pid))
        assert client.get(f'/api/projects/{pid}/export').status_code == 409
        asyncio.run(app.state.locks.release(pid))
        for path in ['../.env', 'assets/../../.env', 'https://example.com/image.png', 'assets/missing.png']:
            changed = copy.deepcopy(world)
            changed['locations'][0]['image'] = path
            store.set_data(pid, 'world', changed)
            assert client.get(f'/api/projects/{pid}/export').status_code == 422, path
            assert not app.state.locks.is_busy(pid)
        # A symlink must not expose a file outside the project.
        (root / 'assets').mkdir(exist_ok=True)
        (Path(tmp) / 'secret.png').write_bytes(b'private')
        (root / 'assets/leak.png').symlink_to(Path(tmp) / 'secret.png')
        changed['locations'][0]['image'] = 'assets/leak.png'
        store.set_data(pid, 'world', changed)
        assert client.get(f'/api/projects/{pid}/export').status_code == 422
        store.set_data(pid, 'world', world)
        store.set_data(pid, 'events', {'nodes': events['nodes'] + [{'id': 'missing', 'title': 'Missing'}], 'edges': []})
        assert client.get(f'/api/projects/{pid}/export').status_code == 422
        assert client.get('/api/projects/no-such-project/export').status_code == 404
        print('PASS: portable export, private-file exclusion, missing scenes/assets, lock release and path containment')


if __name__ == '__main__':
    main()
