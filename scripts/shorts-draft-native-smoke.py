"""Run the Shorts draft client against fresh, isolated Postiz services."""

import argparse
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack
from datetime import datetime, timedelta, timezone
import hashlib
from http.client import HTTPConnection
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
from threading import Barrier, Event, Thread
import time
from urllib.error import HTTPError
from urllib.parse import urlencode, urlsplit
from urllib.request import ProxyHandler, Request, build_opener


REPO = Path(__file__).resolve().parents[1]
BACKEND = 'apps/backend/dist/apps/backend/src/main.js'
ORCHESTRATOR = 'apps/orchestrator/dist/apps/orchestrator/src/main.js'
SCHEMA = 'libraries/nestjs-libraries/src/database/prisma/schema.prisma'
WORKSPACE = 'fixture-workspace'
INTEGRATION = 'fixture-integration'

SEED_FIXTURES = '''
const { PrismaClient } = require('@prisma/client');
const db = new PrismaClient();
(async () => {
  for (const [id, integration, key] of [
    ['fixture-workspace', 'fixture-integration', process.env.FIXTURE_KEY_A],
    ['fixture-other-workspace', 'fixture-other-integration', process.env.FIXTURE_KEY_B],
  ]) {
    await db.organization.create({ data: { id, name: id, apiKey: key } });
    await db.integration.create({ data: {
      id: integration, organizationId: id, internalId: integration,
      name: integration, providerIdentifier: 'linkedin', type: 'social',
      token: 'synthetic-non-provider-token',
    } });
  }
})().finally(() => db.$disconnect()).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
'''

READ_DATABASE = '''
const { PrismaClient } = require('@prisma/client');
const db = new PrismaClient();
(async () => {
  const posts = await db.post.findMany({ orderBy: { id: 'asc' }, select: {
    id: true, state: true, integrationId: true, organizationId: true,
    content: true, image: true, releaseId: true, releaseURL: true,
  } });
  const media = await db.media.findMany({ orderBy: { id: 'asc' }, select: {
    id: true, organizationId: true, path: true,
  } });
  console.log(JSON.stringify({ posts, media }));
})().finally(() => db.$disconnect()).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
'''

COUNT_WORKFLOWS = '''
const { Connection } = require('@temporalio/client');
(async () => {
  const connection = await Connection.connect({ address: process.env.TEMPORAL_ADDRESS });
  try {
    const result = await connection.workflowService.countWorkflowExecutions({
      namespace: process.env.TEMPORAL_NAMESPACE,
    });
    console.log(result.count?.toString() ?? '0');
  } finally {
    await connection.close();
  }
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
'''


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def require_isolation():
    require(sys.platform == 'linux', 'native smoke requires a loopback-only Linux network namespace')
    devices = Path('/proc/self/net/dev').read_text().splitlines()[2:]
    interfaces = {line.split(':', 1)[0].strip() for line in devices if ':' in line}
    require(interfaces == {'lo'}, 'native smoke requires a loopback-only Linux network namespace')
    require(os.geteuid() != 0, 'native smoke requires an unprivileged user')
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.bind(('127.0.0.1', 0))
    except OSError as error:
        raise RuntimeError('native smoke requires the loopback interface to be up') from error


def executable(value):
    resolved = shutil.which(value)
    require(resolved, f'required executable unavailable: {value}')
    return str(Path(resolved).absolute())


def ephemeral_ports(number):
    with ExitStack() as sockets:
        bindings = [sockets.enter_context(socket.socket()) for _ in range(number)]
        for binding in bindings:
            binding.bind(('127.0.0.1', 0))
        return [binding.getsockname()[1] for binding in bindings]


def sha256(path):
    with path.open('rb') as data:
        return hashlib.file_digest(data, 'sha256').hexdigest()


def fixture_draft_request(manifest_path, media):
    manifest = json.loads(manifest_path.read_text())
    key = hashlib.sha256(json.dumps(
        [manifest['workspaceId'], manifest['integrationId'], manifest['contentId']],
        separators=(',', ':'),
    ).encode()).hexdigest()
    return {
        'type': 'draft', 'date': manifest['date'], 'shortLink': False, 'tags': [], 'creationMethod': 'CLI',
        'posts': [{'type': 'draft', 'integration': {'id': manifest['integrationId']},
                   'value': [{'content': f"<p>{manifest['caption']}</p>",
                              'image': [{'id': media['id'], 'path': media['path']}]}]}],
    }, {'Idempotency-Key': key, 'X-Postiz-Draft-Manifest-Sha256': sha256(manifest_path)}


def stop(child):
    if child.poll() is None:
        child.terminate()
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()


def start_fault_proxy(stack, proxy_port, backend_port):
    """Drop one completed draft-create response from the fixture backend."""
    armed, dropped = Event(), Event()

    class Proxy(BaseHTTPRequestHandler):
        def forward(self):
            path = urlsplit(self.path)
            routes = {
                'GET': {'/public/v1/me', '/public/v1/integrations', '/public/v1/posts'},
                'POST': {'/public/v1/upload', '/public/v1/posts'},
            }
            if path.scheme or path.netloc or path.path not in routes[self.command]:
                self.send_error(404)
                return
            limit = 2_000_000
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 <= size <= limit:
                self.send_error(413)
                return
            headers = {name: self.headers[name] for name in (
                'Authorization', 'Content-Type', 'Idempotency-Key', 'X-Postiz-Draft-Manifest-Sha256'
            ) if name in self.headers}
            self.connection.settimeout(5)
            upstream = HTTPConnection('127.0.0.1', backend_port, timeout=5)
            try:
                upstream.request(self.command, self.path, self.rfile.read(size), headers)
                reply = upstream.getresponse()
                data = reply.read(limit + 1)
                if len(data) > limit:
                    self.send_error(502)
                    return
                if (armed.is_set() and self.command == 'POST' and path.path == '/public/v1/posts'
                        and 200 <= reply.status < 300):
                    armed.clear()
                    dropped.set()
                    self.close_connection = True
                    return
                self.send_response(reply.status)
                self.send_header('Content-Type', reply.getheader('Content-Type', 'application/json'))
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)
            finally:
                upstream.close()

        do_GET = do_POST = forward

        def log_message(self, *_):
            pass

    proxy = stack.enter_context(ThreadingHTTPServer(('127.0.0.1', proxy_port), Proxy))
    thread = Thread(target=proxy.serve_forever, daemon=True)
    thread.start()
    stack.callback(thread.join, timeout=5)
    stack.callback(proxy.shutdown)
    return armed, dropped


def smoke(args):
    require_isolation()
    postgres = executable(str(Path(args.postgres_bin_dir) / 'postgres'))
    initdb = executable(str(Path(args.postgres_bin_dir) / 'initdb'))
    redis = executable(args.redis_server)
    temporal = executable(args.temporal)
    node = executable(args.node)
    ffmpeg = executable(args.ffmpeg)
    prisma = executable(str(REPO / 'node_modules/.bin/prisma'))
    for target in (BACKEND, ORCHESTRATOR):
        require((REPO / target).is_file(), f'build the Postiz backend and orchestrator first: {target}')

    with ExitStack() as stack:
        run = Path(stack.enter_context(tempfile.TemporaryDirectory(prefix='postiz-draft-smoke-')))
        upload = run / 'uploads'
        upload.mkdir()
        media_root, media_prefix = upload, '/uploads/'
        if args.verify_private_media:
            from shorts_draft_private_media import PRIVATE_MEDIA_PREFIX, verify_private_media

            media_root, media_prefix = run / 'private-media', PRIVATE_MEDIA_PREFIX
            media_root.mkdir()
        pg_port, redis_port, temporal_port, backend_port, worker_port, proxy_port = ephemeral_ports(6)
        origin = f'http://127.0.0.1:{proxy_port}'
        api = origin + '/public/v1'
        first_key, second_key, password, jwt = [secrets.token_hex(32) for _ in range(4)]
        draft_key = 'pzd_' + secrets.token_hex(32)
        namespace = 'shorts-fixtures-' + secrets.token_hex(6)
        database_user = 'fixture_' + secrets.token_hex(6)
        env = {
            'PATH': f'{Path(node).parent}{os.pathsep}{os.defpath}',
            'LANG': 'C.UTF-8', 'TZ': 'UTC',
            'DATABASE_URL': f'postgresql://{database_user}:{password}@127.0.0.1:{pg_port}/postgres',
            'REDIS_URL': f'redis://127.0.0.1:{redis_port}', 'JWT_SECRET': jwt,
            'FRONTEND_URL': origin, 'MAIN_URL': origin, 'NEXT_PUBLIC_BACKEND_URL': origin,
            'BACKEND_INTERNAL_URL': origin, 'STORAGE_PROVIDER': 'local', 'UPLOAD_DIRECTORY': str(upload),
            'TEMPORAL_ADDRESS': f'127.0.0.1:{temporal_port}', 'TEMPORAL_NAMESPACE': namespace,
            'PORT': str(backend_port), 'ORCHESTRATOR_PORT': str(worker_port),
            'DISABLE_REGISTRATION': 'true',
            'POSTIZ_PILOT_DRAFT_API_ORG_ID': WORKSPACE,
            'POSTIZ_PILOT_DRAFT_API_KEY_SHA256': hashlib.sha256(draft_key.encode()).hexdigest(),
        }
        if args.verify_private_media:
            env['POSTIZ_PRIVATE_LOCAL_MEDIA_DIRECTORY'] = str(media_root)
        running = {}
        http = build_opener(ProxyHandler({}))

        def redact(detail):
            for value in (first_key, second_key, password, jwt, draft_key):
                detail = detail.replace(value, '[fixture secret]')
            return detail

        def call(command, extra=None, timeout=65, expected=0, stdin=None):
            result = subprocess.run(command, cwd=REPO, env=env | (extra or {}),
                                    input=stdin, capture_output=True, text=True,
                                    errors='replace', timeout=timeout)
            require(result.returncode == expected,
                    f'{Path(command[0]).name} exited {result.returncode}: '
                    f'{redact(result.stderr[-3000:])}')
            return result.stdout if expected == 0 else redact(result.stderr)

        def launch(label, command, extra=None):
            log = run / f'{label}.log'
            with log.open('wb') as output:
                child = subprocess.Popen(command, cwd=REPO, env=env | (extra or {}),
                                         stdout=output, stderr=subprocess.STDOUT)
            running[label] = (child, log)
            stack.callback(stop, child)
            return child

        def wait_ready(label, check):
            deadline = time.monotonic() + 60
            while time.monotonic() < deadline:
                for name, (child, log) in running.items():
                    if child.poll() is not None:
                        detail = redact(log.read_text(errors='replace')[-3000:])
                        raise RuntimeError(f'{name} exited {child.returncode}: {detail}')
                try:
                    if check():
                        return
                except (OSError, TimeoutError):
                    pass
                time.sleep(0.25)
            raise RuntimeError(f'timed out waiting for {label}')

        def listening(port):
            with socket.create_connection(('127.0.0.1', port), timeout=1):
                return True

        def get(url, key=None):
            headers = {'Authorization': key} if key is not None else {}
            with http.open(Request(url, headers=headers), timeout=3) as response:
                return json.load(response)

        def verify_backend():
            return get(api + '/me', first_key).get('organization', {}).get('id') == WORKSPACE

        def draft_api_request(method, path, body=None, headers=None, *, status, port=None):
            # Call the real backend directly so the synthetic proxy's own
            # allowlist cannot satisfy the scope or idempotency assertions.
            base = f'http://127.0.0.1:{port or backend_port}/public/v1'
            request = Request(base + path, method=method,
                              data=json.dumps(body).encode() if body is not None else None,
                              headers={'Authorization': draft_key,
                                       'Content-Type': 'application/json', **(headers or {})})
            payload = None
            try:
                with http.open(request, timeout=3) as response:
                    actual = response.status
                    if 200 <= actual < 300:
                        payload = json.load(response)
            except HTTPError as error:
                with error:
                    actual = error.code
            require(actual == status, f'scoped credential expected HTTP {status} for {method} {path}, got {actual}')
            return payload

        pgdata = str(run / 'pgdata')
        init = [initdb, '-A', 'scram-sha-256', '-U', database_user,
                '--pwfile=/dev/stdin', '-D', pgdata]
        if args.postgres_share_dir:
            init.extend(['-L', str(Path(args.postgres_share_dir).resolve())])
        call(init, stdin=password + '\n')
        launch('postgres', [postgres, '-D', pgdata, '-h', '127.0.0.1', '-p', str(pg_port),
                            '-c', 'unix_socket_directories='])
        redis_env = {'LD_LIBRARY_PATH': args.redis_library_dir} if args.redis_library_dir else None
        launch('redis', [redis, '--bind', '127.0.0.1', '--port', str(redis_port),
                         '--dir', str(run), '--save', '', '--appendonly', 'no'], redis_env)
        launch('temporal', [temporal, 'server', 'start-dev', '--headless', '--namespace', namespace,
                            '--ip', '127.0.0.1', '--port', str(temporal_port),
                            '--db-filename', str(run / 'temporal.db'), '--log-level', 'error'])
        for name, port in [('PostgreSQL', pg_port), ('Redis', redis_port), ('Temporal', temporal_port)]:
            wait_ready(name, lambda: listening(port))

        # This DSN is generated above for the cluster initialised in this private
        # temp directory. Its credentials and network path are never inherited.
        call([prisma, 'db', 'push', '--skip-generate', '--schema', SCHEMA])
        call([node, '-e', SEED_FIXTURES], {'FIXTURE_KEY_A': first_key, 'FIXTURE_KEY_B': second_key})
        backend = launch('backend', [node, '--experimental-require-module', BACKEND])
        launch('orchestrator', [node, '--experimental-require-module', ORCHESTRATOR])
        wait_ready('Postiz backend port', lambda: listening(backend_port))
        armed, dropped = start_fault_proxy(stack, proxy_port, backend_port)
        wait_ready('Postiz workspace API', verify_backend)
        try:
            scoped_workspace = get(api + '/me', draft_key).get('organization', {}).get('id')
        except HTTPError as error:
            with error:
                raise RuntimeError(f'scoped credential could not verify its workspace, HTTP {error.code}') from None
        require(scoped_workspace == WORKSPACE, 'scoped credential did not verify its configured workspace')
        draft_api_request('GET', '/me', headers={'Authorization': 'pzd_' + '0' * 64}, status=401)
        draft_api_request('GET', '/me', headers={'x-postiz-org': 'fixture-other-workspace'}, status=403)
        draft_api_request('GET', '/me', headers={'x-postiz-include-deleted': 'true'}, status=403)
        draft_api_request('GET', '/media', status=403)
        draft_api_request('GET', '/is-connected', status=403)
        require(draft_api_request('GET', '/is-connected', headers={'Authorization': first_key}, status=200)
                == {'connected': True}, 'the legacy API key lost access to its ordinary route')
        draft_api_request('POST', '/upload-from-url', {'url': 'https://example.invalid/fixture.mp4'}, status=403)
        draft_api_request('POST', '/posts', {'type': 'now'}, status=403)
        draft_api_request('POST', '/posts', {'type': 'schedule'}, status=403)
        draft_api_request('PUT', '/posts/fixture-post/settings', {}, status=403)
        draft_api_request('DELETE', '/posts/fixture-post', status=403)
        health = f'http://127.0.0.1:{worker_port}/health/status'
        wait_ready('Temporal worker health', lambda: get(health).get('status') == 'ok')
        before = int(call([node, '-e', COUNT_WORKFLOWS]).strip())
        require(before == 0, 'fixture Temporal namespace unexpectedly contains workflow executions')

        fixture = run / 'synthetic.mp4'
        call([ffmpeg, '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=160x240:d=1',
              '-threads', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(fixture)])
        timestamp = datetime.now(timezone.utc).replace(microsecond=0) + timedelta(days=1)
        date = timestamp.isoformat().replace('+00:00', 'Z')
        manifest = run / 'manifest.json'
        manifest.write_text(json.dumps({
            'version': 1, 'contentId': 'fixture-native-draft', 'workspaceId': WORKSPACE,
            'integrationId': INTEGRATION, 'provider': 'linkedin', 'date': date,
            'caption': 'Synthetic native smoke draft', 'media': fixture.name,
            'mediaSha256': sha256(fixture),
        }))
        submit = [node, 'scripts/shorts-draft.mjs', '--endpoint', api, '--manifest', str(manifest),
                  '--apply', '--expected-manifest-sha256', sha256(manifest), '--journal-dir', str(run / 'receipts')]
        scoped_submit = [*submit, '--require-scoped-key']
        first = json.loads(call(scoped_submit, {'POSTIZ_API_KEY': draft_key}))
        require(first['stage'] == 'verified' and not first['reused'], 'initial write did not verify as a new draft')

        stop(backend)
        launch('backend-restarted', [node, '--experimental-require-module', BACKEND])
        del running['backend']
        wait_ready('restarted Postiz backend port', lambda: listening(backend_port))
        wait_ready('restarted Postiz workspace API', verify_backend)
        replay = json.loads(call(scoped_submit, {'POSTIZ_API_KEY': draft_key}))
        require(replay['stage'] == 'verified' and replay['reused'] and replay['postId'] == first['postId'],
                'same-journal replay after restart did not return the original draft')

        query = urlencode({
            'startDate': (timestamp - timedelta(minutes=1)).isoformat(),
            'endDate': (timestamp + timedelta(minutes=1)).isoformat(),
        })
        require(get(api + '/posts?' + query, second_key)['posts'] == [], 'second tenant can see the fixture draft')
        rejected = call(submit, {'POSTIZ_API_KEY': second_key}, expected=1)
        require('different workspace' in rejected.lower(), 'wrong-tenant submit failed for an unexpected reason')
        state = json.loads(call([node, '-e', READ_DATABASE]))
        require(len(state['posts']) == len(state['media']) == 1, 'expected exactly one persisted post and media row')
        post, media = state['posts'][0], state['media'][0]
        require(post['id'] == first['postId'] and post['state'] == 'DRAFT' and not post['releaseId'] and not post['releaseURL'],
                'the persisted post is not the expected unreleased draft')
        require(post['organizationId'] == media['organizationId'] == WORKSPACE,
                'the stored draft and media are not owned by the expected workspace')
        require(post['integrationId'] == INTEGRATION and 'Synthetic native smoke draft' in post['content'],
                'the stored post lost the reviewed caption or integration')
        require(json.loads(post['image'])[0]['id'] == media['id'] == first['mediaId'], 'the stored draft lost its media attachment')

        # The CLI's journal replay above only polls. A direct repeat of the
        # same scoped mutation after the restart tests the server receipt.
        request_body, request_headers = fixture_draft_request(manifest, media)
        server_replay = draft_api_request('POST', '/posts', request_body, request_headers, status=201)
        require(server_replay == [{'postId': first['postId'], 'integration': INTEGRATION}],
                'server did not return the original draft receipt after restart')
        draft_api_request('POST', '/posts', request_body,
                          {**request_headers, 'X-Postiz-Draft-Manifest-Sha256': '0' * 64}, status=409)
        require(json.loads(call([node, '-e', READ_DATABASE])) == state,
                'repeat or conflict changed the persisted draft and media rows')
        path = urlsplit(media['path']).path
        require(path.startswith(media_prefix), 'the stored media path is outside the fixture uploads')
        asset = (media_root / path.removeprefix(media_prefix)).resolve()
        require(asset.is_relative_to(media_root) and sha256(asset) == first['mediaSha256'] == sha256(fixture),
                'the stored media digest differs from the synthetic input')
        call([ffmpeg, '-v', 'error', '-xerror', '-i', str(asset), '-f', 'null', '-'])

        lost_manifest = run / 'lost-response-manifest.json'
        lost_caption = 'Synthetic draft with interrupted create response'
        lost_manifest.write_text(json.dumps({
            **json.loads(manifest.read_text()),
            'contentId': 'fixture-lost-response', 'caption': lost_caption,
        }))
        lost_submit = [node, 'scripts/shorts-draft.mjs', '--endpoint', api,
                       '--manifest', str(lost_manifest), '--apply', '--require-scoped-key',
                       '--expected-manifest-sha256', sha256(lost_manifest),
                       '--journal-dir', str(run / 'lost-receipts')]
        armed.set()
        lost = call(lost_submit, {'POSTIZ_API_KEY': draft_key}, expected=1)
        require(dropped.is_set() and 'POST /posts did not return a response' in lost,
                'interrupted create returned an unexpected error')
        after_interruption = json.loads(call([node, '-e', READ_DATABASE]))
        retry = call(lost_submit, {'POSTIZ_API_KEY': draft_key}, expected=1)
        require('An earlier attempt may have written data' in retry,
                'the client did not hold the uncertain create for reconciliation')
        final = json.loads(call([node, '-e', READ_DATABASE]))
        require(after_interruption == final and len(final['posts']) == len(final['media']) == 2,
                'the interrupted fixture did not persist exactly once across retry')
        [interrupted_post] = [row for row in final['posts'] if lost_caption in row['content']]
        require(interrupted_post['state'] == 'DRAFT' and not interrupted_post['releaseId']
                and not interrupted_post['releaseURL']
                and interrupted_post['organizationId'] == WORKSPACE,
                'the interrupted fixture did not persist as an unreleased draft in the expected workspace')
        interrupted_media_id = json.loads(interrupted_post['image'])[0]['id']
        interrupted_media = next((row for row in final['media'] if row['id'] == interrupted_media_id), None)
        require(interrupted_media_id != media['id'] and interrupted_media
                and interrupted_media['organizationId'] == WORKSPACE,
                'the interrupted draft does not own a distinct media row')

        stop(running.pop('backend-restarted')[0])
        launch('backend-restarted', [node, '--experimental-require-module', BACKEND])
        wait_ready('restarted backend port after the lost response', lambda: listening(backend_port))
        wait_ready('Postiz workspace API after the lost response', verify_backend)
        lost_body, lost_headers = fixture_draft_request(lost_manifest, interrupted_media)
        expected_lost_receipt = [{'postId': interrupted_post['id'], 'integration': INTEGRATION}]
        require(draft_api_request('POST', '/posts', lost_body, lost_headers, status=201) == expected_lost_receipt,
                'the server could not recover the lost scoped receipt after restart')
        require(json.loads(call([node, '-e', READ_DATABASE])) == final,
                'issued rows changed when recovering the lost receipt')

        concurrent_manifest = run / 'concurrent-manifest.json'
        concurrent_manifest.write_text(json.dumps({
            **json.loads(manifest.read_text()), 'contentId': 'fixture-concurrent-draft',
            'caption': 'Synthetic concurrent native smoke draft',
        }))
        concurrent_body, concurrent_headers = fixture_draft_request(concurrent_manifest, media)
        start_writes = Barrier(2)

        def create_concurrent_draft():
            start_writes.wait(timeout=3)
            return draft_api_request('POST', '/posts', concurrent_body, concurrent_headers, status=201)

        with ThreadPoolExecutor(max_workers=2) as pool:
            writes = [pool.submit(create_concurrent_draft) for _ in range(2)]
            receipts = [write.result() for write in writes]
        require(receipts[0] == receipts[1] and len(receipts[0]) == 1,
                'concurrent first writes did not return one surviving receipt')
        before_concurrent = final
        final = json.loads(call([node, '-e', READ_DATABASE]))
        added_posts = [row for row in final['posts'] if row not in before_concurrent['posts']]
        require(len(added_posts) == 1 and len(final['posts']) == 3
                and final['media'] == before_concurrent['media'],
                'concurrent first writes did not create exactly one draft and no media rows')
        [concurrent_post] = added_posts
        require(concurrent_post['id'] == receipts[0][0]['postId'] and concurrent_post['state'] == 'DRAFT'
                and not concurrent_post['releaseId'] and not concurrent_post['releaseURL']
                and concurrent_post['organizationId'] == WORKSPACE,
                'concurrent first writes returned an unexpected or released draft')

        after = int(call([node, '-e', COUNT_WORKFLOWS]).strip())
        require(after == 0, 'the draft run produced an unexpected Temporal workflow execution')
        evidence = {
            'draftId': post['id'], 'mediaId': media['id'],
            'decodedMediaHashVerified': True, 'crossWorkspaceReadEmpty': True,
            'wrongWorkspaceWriteRejected': True, 'sameJournalReplayAcrossApiRestart': True,
            'scopedCredentialDeniedOtherActions': True, 'serverReceiptReplayAcrossApiRestart': True,
            'serverReceiptConflictLeftDraftUnchanged': True,
            'lostResponsePersistedOnceAndRetryHeld': True,
            'lostScopedReceiptRecoveredAfterRestart': True, 'concurrentWritesReturnedOneDraft': True,
            'persistedDrafts': len(final['posts']), 'persistedMediaRows': len(final['media']),
            'temporalExecutionsBefore': before, 'temporalExecutionsAfter': after,
        }
        if args.verify_private_media:
            evidence['privateMediaHttp'] = verify_private_media(
                call=call, node=node, backend_port=backend_port, asset_path=path,
                fixture_key=jwt, expected_digest=first['mediaSha256'], public_uploads=upload,
            )
        if args.verify_restore:
            from shorts_draft_fixture_restore import rehearse_fixture_restore

            stop(running.pop('backend-restarted')[0])
            restored_port = ephemeral_ports(1)[0]
            restored_api = f'http://127.0.0.1:{restored_port}/public/v1'
            private_uploads = env.get('POSTIZ_PRIVATE_LOCAL_MEDIA_DIRECTORY')

            def verify_restored(database, restored_media):
                restored_env = {
                    'DATABASE_URL': env['DATABASE_URL'].rsplit('/', 1)[0] + '/' + database,
                    'PORT': str(restored_port),
                    'UPLOAD_DIRECTORY': str(upload if private_uploads else restored_media),
                }
                if private_uploads:
                    restored_env['POSTIZ_PRIVATE_LOCAL_MEDIA_DIRECTORY'] = str(restored_media)

                restored_state = json.loads(call([node, '-e', READ_DATABASE], restored_env))
                require(restored_state == final, 'restored metadata differs from the synthetic fixture')
                launch('restored-backend', [node, '--experimental-require-module', BACKEND], restored_env)
                wait_ready('restored Postiz workspace API', lambda: (
                    get(restored_api + '/me', first_key).get('organization', {}).get('id') == WORKSPACE
                ))
                owner = get(restored_api + '/posts?' + query, first_key)['posts']
                other = get(restored_api + '/posts?' + query, second_key)['posts']
                require({row['id'] for row in owner} == {row['id'] for row in final['posts']},
                        'restored workspace API did not return all fixture drafts to their owner')
                require(other == [], 'the other workspace could see a restored draft')
                receipt = draft_api_request('POST', '/posts', request_body, request_headers,
                                            status=201, port=restored_port)
                require(receipt == server_replay and
                        json.loads(call([node, '-e', READ_DATABASE], restored_env)) == restored_state,
                        'the restored receipt did not protect the fixture from a duplicate draft')
                return {
                    'ownerDraftsVisible': True, 'otherTenantDraftsHidden': True,
                    'restoredDraftReceiptReplayVerified': True,
                }

            evidence['localMetadataAndMediaRestore'] = rehearse_fixture_restore(
                run=run, uploads=Path(private_uploads) if private_uploads else upload,
                media=final['media'], origin=origin, postgres_bin_dir=Path(args.postgres_bin_dir),
                database_port=pg_port, database_user=database_user, database_password=password,
                ffmpeg=ffmpeg, call=call, verify_restored=verify_restored,
            )
            require(int(call([node, '-e', COUNT_WORKFLOWS]).strip()) == after,
                    'the restore rehearsal produced an unexpected Temporal workflow execution')
        return evidence


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--postgres-bin-dir', required=True)
    parser.add_argument('--postgres-share-dir')
    parser.add_argument('--redis-server', default='redis-server')
    parser.add_argument('--redis-library-dir')
    parser.add_argument('--temporal', default='temporal')
    parser.add_argument('--node', default='node')
    parser.add_argument('--ffmpeg', default='ffmpeg')
    parser.add_argument('--verify-private-media', action='store_true',
                        help='verify private byte-range delivery in the real fixture API')
    parser.add_argument('--verify-restore', action='store_true',
                        help='rehearse a backup and restore within this local synthetic fixture')
    args = parser.parse_args()
    signal.signal(signal.SIGTERM, lambda signum, frame: sys.exit(128 + signum))
    try:
        print(json.dumps(smoke(args), indent=2))
    except (RuntimeError, OSError, subprocess.TimeoutExpired, ValueError, KeyError) as error:
        sys.exit(f'native draft smoke failed: {error}')


if __name__ == '__main__':
    main()
