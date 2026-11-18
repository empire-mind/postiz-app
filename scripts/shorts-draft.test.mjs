import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('./shorts-draft.mjs', import.meta.url));
const prefix = '/api/public/v1';
const fixtureKey = 'fixture-only-postiz-key';
const fixtureAsset = Buffer.from(
  '000000206674797069736f6d0000020069736f6d69736f32617663316d7034310000000c6d64617400000000',
  'hex'
);

function sha(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function json(response, body, status = 200) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function consume(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'postiz-shorts-draft-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifestPath = join(root, 'handoff.json');
  const journal = join(root, 'journal');
  const assetPath = join(root, 'fixture.mp4');
  const manifest = {
    version: 1,
    contentId: 'content-001',
    workspaceId: 'workspace-001',
    integrationId: 'integration-001',
    provider: 'youtube',
    date: '2031-07-15T11:30:00.000Z',
    caption: 'Owned clip <take 2> & approved notes',
    media: 'fixture.mp4',
    mediaSha256: sha(fixtureAsset),
  };
  const manifestBytes = JSON.stringify(manifest);
  await Promise.all([
    mkdir(journal),
    writeFile(manifestPath, manifestBytes),
    writeFile(assetPath, fixtureAsset),
  ]);

  const requests = [];
  const serverErrors = [];
  let origin;
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, origin);
      const call = {
        method: request.method,
        path: url.pathname,
        query: url.searchParams,
        authorization: request.headers.authorization,
        contentType: request.headers['content-type'],
        body: await consume(request),
      };
      requests.push(call);
      const path = call.path.startsWith('/public/v1/') ? '/api' + call.path : call.path;
      const route = call.method + ' ' + path;

      if (route === 'GET ' + prefix + '/me') {
        if (options.redirectTo) {
          response.writeHead(302, { location: options.redirectTo });
          response.end();
          return;
        }
        json(response, {
          organization: { id: options.workspaceId ?? manifest.workspaceId },
        });
      } else if (route === 'GET ' + prefix + '/integrations') {
        json(response, [{
          id: options.integrationId ?? manifest.integrationId,
          identifier: options.provider ?? manifest.provider,
          disabled: options.disabled ?? false,
        }]);
      } else if (route === 'POST ' + prefix + '/upload') {
        json(response, { id: 'asset-001', path: options.uploadPath ?? origin + '/uploads/fixture.mp4' }, 201);
      } else if (route === 'POST ' + prefix + '/posts') {
        if (options.loseCreateResponse) {
          // The receiver accepted the request, but the sender sees no receipt.
          response.destroy();
          return;
        }
        json(response, [{ postId: 'draft-001', integration: manifest.integrationId }], 201);
      } else if (route === 'GET ' + prefix + '/posts') {
        json(response, { posts: [{
          id: 'draft-001',
          state: options.readbackState ?? 'DRAFT',
          content: options.readbackContent ?? '<p>Owned clip &lt;take 2&gt; &amp; approved notes</p>',
          publishDate: options.readbackDate ?? '2031-07-15T11:30:00.000Z',
          releaseId: null,
          releaseURL: null,
          integration: { id: manifest.integrationId, providerIdentifier: manifest.provider },
        }] });
      } else {
        json(response, { message: 'Unexpected fixture route' }, 404);
      }
    } catch (error) {
      serverErrors.push(error);
      response.destroy();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  origin = 'http://127.0.0.1:' + server.address().port;
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  }));

  async function run(overrides = {}) {
    const args = [
      cli, '--manifest', manifestPath, '--endpoint', overrides.endpoint ?? origin + prefix,
    ];
    if (overrides.apply) {
      args.push(
        '--apply', '--expected-manifest-sha256', overrides.manifestSha ?? sha(manifestBytes),
        '--journal-dir', journal
      );
    }
    try {
      const result = await exec(process.execPath, args, {
        env: { ...process.env, POSTIZ_API_KEY: fixtureKey },
        timeout: 15_000,
      });
      return { ...result, code: 0 };
    } catch (error) {
      if (error.killed) throw error;
      return { stdout: error.stdout, stderr: error.stderr, code: error.code };
    } finally {
      assert.deepEqual(serverErrors, []);
    }
  }

  return { requests, run, manifest, manifestPath, assetPath, origin };
}

function routeLabels(requests) {
  return requests.map(({ method, path }) => method + ' ' + path);
}

function mutations(requests) {
  return requests.filter(({ method }) => method === 'POST');
}

test('dry run validates owned media without any HTTP calls', async (t) => {
  const f = await fixture(t);
  const result = await f.run();
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(f.requests, []);
  assert.doesNotMatch(result.stdout + result.stderr, /fixture-only-postiz-key/);
});

test('apply sends one multipart upload and one draft-only request, then reads it back', async (t) => {
  const f = await fixture(t);
  const result = await f.run({ apply: true });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(routeLabels(f.requests), [
    'GET ' + prefix + '/me',
    'GET ' + prefix + '/integrations',
    'POST ' + prefix + '/upload',
    'POST ' + prefix + '/posts',
    'GET ' + prefix + '/posts',
  ]);
  assert(f.requests.every(({ authorization }) => authorization === fixtureKey));
  const upload = f.requests[2];
  assert.match(upload.contentType, /^multipart\/form-data; boundary=/);
  assert.match(upload.body.toString(), /name="file"/);
  assert(upload.body.includes(fixtureAsset));
  const post = JSON.parse(f.requests[3].body);
  assert.equal(post.type, 'draft');
  assert.equal(post.posts.length, 1);
  assert.equal(post.posts[0].type, 'draft');
  assert.equal(post.posts[0].integration.id, f.manifest.integrationId);
  assert.equal(post.posts[0].value[0].image[0].id, 'asset-001');
  assert.equal(post.posts[0].value[0].image[0].path, f.origin + '/uploads/fixture.mp4');
  assert(!post.posts[0].value[0].content.includes('<take 2>'));
  const { query } = f.requests[4];
  assert(Date.parse(query.get('startDate')) <= Date.parse(f.manifest.date));
  assert(Date.parse(query.get('endDate')) >= Date.parse(f.manifest.date));
  assert.doesNotMatch(result.stdout + result.stderr, /fixture-only-postiz-key/);
});

test('a changed manifest fails its expected digest before network I/O', async (t) => {
  const f = await fixture(t);
  await writeFile(f.manifestPath, JSON.stringify({ ...f.manifest, caption: 'Changed' }));
  const result = await f.run({ apply: true });
  assert.notEqual(result.code, 0);
  assert.deepEqual(f.requests, []);
});

test('a media fingerprint mismatch fails before network I/O', async (t) => {
  const f = await fixture(t);
  await writeFile(f.assetPath, Buffer.concat([fixtureAsset, Buffer.from([42])]));
  const result = await f.run({ apply: true });
  assert.notEqual(result.code, 0);
  assert.deepEqual(f.requests, []);
});

test('an unsupported root field cannot change a handoff into a schedule request', async (t) => {
  const f = await fixture(t);
  const changed = JSON.stringify({ ...f.manifest, type: 'schedule' });
  await writeFile(f.manifestPath, changed);
  const result = await f.run({ apply: true, manifestSha: sha(changed) });
  assert.notEqual(result.code, 0);
  assert.deepEqual(f.requests, []);
});

test('workspace and target mismatches block all upload and draft mutations', async (t) => {
  for (const [label, options] of [
    ['workspace mismatch', { workspaceId: 'other-workspace' }],
    ['integration mismatch', { integrationId: 'other-integration' }],
    ['provider mismatch', { provider: 'other-provider' }],
    ['disabled integration', { disabled: true }],
  ]) {
    await t.test(label, async (t) => {
      const f = await fixture(t, options);
      const result = await f.run({ apply: true });
      assert.notEqual(result.code, 0);
      assert.equal(f.requests[0]?.path, prefix + '/me');
      assert.deepEqual(mutations(f.requests), []);
    });
  }
});

test('two concurrent applies share one upload and draft mutation sequence', async (t) => {
  const f = await fixture(t);
  const results = await Promise.all([f.run({ apply: true }), f.run({ apply: true })]);
  assert(results.some(({ code }) => code === 0), JSON.stringify(results));
  assert.deepEqual(routeLabels(mutations(f.requests)), [
    'POST ' + prefix + '/upload',
    'POST ' + prefix + '/posts',
  ]);
});

test('the alternate public API path reuses the draft on the same origin', async (t) => {
  const f = await fixture(t);
  const first = await f.run({ apply: true });
  assert.equal(first.code, 0, first.stderr);
  const second = await f.run({ apply: true, endpoint: f.origin + '/public/v1' });
  assert.equal(second.code, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).reused, true);
  assert.deepEqual(routeLabels(mutations(f.requests)), [
    'POST ' + prefix + '/upload',
    'POST ' + prefix + '/posts',
  ]);
});

test('a lost create receipt never triggers another upload or draft on replay', async (t) => {
  const f = await fixture(t, { loseCreateResponse: true });
  const first = await f.run({ apply: true });
  assert.notEqual(first.code, 0);
  await f.run({ apply: true });
  assert.deepEqual(routeLabels(mutations(f.requests)), [
    'POST ' + prefix + '/upload',
    'POST ' + prefix + '/posts',
  ]);
});

test('a readback outside DRAFT rejects acceptance without replaying mutations', async (t) => {
  const f = await fixture(t, { readbackState: 'QUEUE' });
  const first = await f.run({ apply: true });
  assert.notEqual(first.code, 0);
  await f.run({ apply: true });
  assert.deepEqual(routeLabels(mutations(f.requests)), [
    'POST ' + prefix + '/upload',
    'POST ' + prefix + '/posts',
  ]);
});

test('read-back rejects a changed caption or calendar time without repeating the write', async (t) => {
  for (const [label, changes] of [
    ['caption changed', { readbackContent: '<p>A different caption</p>' }],
    ['calendar time moved', { readbackDate: '2031-07-15T11:30:15.000Z' }],
  ]) {
    await t.test(label, async (t) => {
      const readback = {};
      const f = await fixture(t, readback);
      const result = await f.run({ apply: true });
      assert.equal(result.code, 0, result.stderr);

      // The saved draft no longer matches the reviewed export.
      Object.assign(readback, changes);
      const replay = await f.run({ apply: true });

      assert.equal(replay.code, 1, replay.stdout);
      assert.match(replay.stderr, /read-back/i);
      assert.deepEqual(routeLabels(mutations(f.requests)), [
        'POST ' + prefix + '/upload',
        'POST ' + prefix + '/posts',
      ]);
    });
  }
});

test('the approved caption round-trips with a nonbreaking space and a carriage-return line break', async (t) => {
  const f = await fixture(t, { readbackContent: '<p>A&nbsp;caption</p><p>Next line</p>' });
  const changed = JSON.stringify({ ...f.manifest, caption: 'A\u00a0caption\rNext line' });
  await writeFile(f.manifestPath, changed);

  const result = await f.run({ apply: true, manifestSha: sha(changed) });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(f.requests[3].body).posts[0].value[0].content,
    '<p>A&nbsp;caption</p><p>Next line</p>');
});

test('a null character in the reviewed caption is rejected before any HTTP call', async (t) => {
  const f = await fixture(t);
  const changed = JSON.stringify({ ...f.manifest, caption: 'A\u0000 caption' });
  await writeFile(f.manifestPath, changed);

  const result = await f.run({ apply: true, manifestSha: sha(changed) });

  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stderr, /caption.*null/i);
  assert.deepEqual(f.requests, []);
});

test('a media path on a different origin blocks draft creation', async (t) => {
  const f = await fixture(t, { uploadPath: 'https://example.invalid/uploads/fixture.mp4' });
  const result = await f.run({ apply: true });
  assert.notEqual(result.code, 0);
  assert.deepEqual(routeLabels(mutations(f.requests)), ['POST ' + prefix + '/upload']);
});

test('the apply route rejects non-loopback and URL-credential endpoints', async (t) => {
  const f = await fixture(t);
  for (const endpoint of [
    'http://192.0.2.23' + prefix,
    f.origin.replace('://', '://user:password@') + prefix,
  ]) {
    const result = await f.run({ apply: true, endpoint });
    assert.notEqual(result.code, 0);
  }
  assert.deepEqual(f.requests, []);
});

test('a redirect is not followed even when the destination is another loopback port', async (t) => {
  const target = await fixture(t);
  const source = await fixture(t, { redirectTo: target.origin + prefix + '/me' });
  const result = await source.run({ apply: true });
  assert.notEqual(result.code, 0);
  assert.deepEqual(routeLabels(source.requests), ['GET ' + prefix + '/me']);
  assert.deepEqual(target.requests, []);
});
