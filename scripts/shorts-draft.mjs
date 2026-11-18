import { createHash, randomUUID } from 'node:crypto';
import { openAsBlob } from 'node:fs';
import { mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';

const manifestKeys = [
  'version', 'contentId', 'workspaceId', 'integrationId', 'provider',
  'date', 'caption', 'media', 'mediaSha256',
];
const sha256 = /^[a-f0-9]{64}$/;
const identifier = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/;
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function pilotEndpoint(value) {
  let endpoint;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error('Use a Postiz API endpoint on http://127.0.0.1:<port>.');
  }
  assert(
    endpoint.protocol === 'http:' && endpoint.hostname === '127.0.0.1' &&
      !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash &&
      /^\/(?:api\/)?public\/v1\/?$/.test(endpoint.pathname) &&
      /^http:\/\/127\.0\.0\.1:\d+\//.test(value),
    'Use an explicit HTTP 127.0.0.1 port and the /api/public/v1 or /public/v1 path.'
  );
  return endpoint.href.replace(/\/$/, '');
}

async function readManifest(file) {
  const bytes = await readFile(file);
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('The manifest must be a JSON object.');
  }
  assert(
    manifest && typeof manifest === 'object' && !Array.isArray(manifest) &&
      Object.keys(manifest).length === manifestKeys.length &&
      manifestKeys.every((key) => Object.hasOwn(manifest, key)),
    'The manifest has missing or unsupported fields.'
  );
  assert(manifest.version === 1, 'Unsupported manifest version.');
  for (const key of ['contentId', 'workspaceId', 'integrationId', 'provider']) {
    assert(typeof manifest[key] === 'string' && identifier.test(manifest[key]), 'Invalid ' + key + '.');
  }
  assert(
    typeof manifest.date === 'string' &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(manifest.date),
    'Use an explicit UTC draft calendar date.'
  );
  const date = new Date(manifest.date);
  assert(
    Number.isFinite(+date) &&
      date.toISOString().replace('.000Z', 'Z') === manifest.date.replace('.000Z', 'Z'),
    'Invalid UTC draft calendar date.'
  );
  assert(
    typeof manifest.caption === 'string' && manifest.caption.trim().length > 0,
    'A caption is required.'
  );
  assert(!manifest.caption.includes('\0'), 'The reviewed caption cannot contain a null character.');
  assert(
    typeof manifest.mediaSha256 === 'string' && sha256.test(manifest.mediaSha256),
    'A lowercase SHA-256 media digest is required.'
  );
  assert(
    typeof manifest.media === 'string' && !isAbsolute(manifest.media) &&
      extname(manifest.media).toLowerCase() === '.mp4',
    'Media must be an MP4 path relative to the manifest.'
  );

  return { manifest, date: date.toISOString(), manifestSha256: digest(bytes) };
}

async function approvedMedia(file, manifest) {
  const bundleDirectory = await realpath(dirname(file));
  const mediaFile = await realpath(resolve(bundleDirectory, manifest.media));
  const fromBundle = relative(bundleDirectory, mediaFile);
  assert(
    fromBundle && fromBundle !== '..' && !fromBundle.startsWith('..' + sep) &&
      !isAbsolute(fromBundle),
    'Media must resolve inside the manifest directory.'
  );
  const media = await openAsBlob(mediaFile, { type: 'video/mp4' });
  assert(media.size > 0, 'Media is empty.');
  const hash = createHash('sha256');
  for await (const bytes of media.stream()) hash.update(bytes);
  assert(hash.digest('hex') === manifest.mediaSha256, 'Media SHA-256 does not match the manifest.');
  return media;
}

function postizClient(endpoint, key) {
  return async (method, path, body) => {
    let response;
    try {
      response = await fetch(endpoint + path, {
        method,
        headers: {
          Authorization: key,
          ...(typeof body === 'string' ? { 'Content-Type': 'application/json' } : {}),
        },
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(method === 'POST' ? 120_000 : 15_000),
      });
    } catch {
      throw new Error(method + ' ' + path.split('?')[0] + ' did not return a response.');
    }

    assert(
      response.ok,
      method + ' ' + path.split('?')[0] + ' returned HTTP ' + response.status + '.'
    );
    try {
      return await response.json();
    } catch {
      throw new Error(method + ' ' + path.split('?')[0] + ' did not return JSON.');
    }
  };
}

async function verifyDestination(request, manifest) {
  const me = await request('GET', '/me');
  assert(me?.organization?.id === manifest.workspaceId, 'The Postiz credential belongs to a different workspace.');
  const integrations = await request('GET', '/integrations');
  assert(Array.isArray(integrations), 'Could not verify the Postiz integration list.');
  const target = integrations.find(({ id }) => id === manifest.integrationId);
  assert(
    target?.identifier === manifest.provider && target.disabled === false,
    'The selected Postiz integration or provider is unavailable.'
  );
}

function captionHtml(caption) {
  const escape = (value) => value.replace(/[&<>\u00a0]/g, (char) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '\u00a0': '&nbsp;' }[char]
  ));
  return caption.trim().split(/\r\n?|\n/).map((line) => (
    '<p>' + escape(line) + '</p>'
  )).join('');
}

function draftBody(manifest, date, media) {
  return {
    type: 'draft',
    date,
    shortLink: false,
    tags: [],
    creationMethod: 'CLI',
    posts: [{
      type: 'draft',
      integration: { id: manifest.integrationId },
      value: [{ content: captionHtml(manifest.caption), image: [{ id: media.id, path: media.path }] }],
    }],
  };
}

async function verifyDraft(request, manifest, date, postId) {
  const calendarTime = Date.parse(date);
  const range = new URLSearchParams({
    startDate: new Date(calendarTime - 60_000).toISOString(),
    endDate: new Date(calendarTime + 60_000).toISOString(),
  });
  const data = await request('GET', '/posts?' + range);
  const post = Array.isArray(data?.posts) && data.posts.find(({ id }) => id === postId);
  assert(
    post && post.state === 'DRAFT' && post.releaseId === null && post.releaseURL === null &&
      post.integration?.id === manifest.integrationId &&
      post.integration?.providerIdentifier === manifest.provider &&
      post.content === captionHtml(manifest.caption) &&
      typeof post.publishDate === 'string' && Date.parse(post.publishDate) === calendarTime,
    'Read-back did not confirm the reviewed caption, calendar time and unpublished DRAFT destination.'
  );
}

async function saveJournal(path, entry) {
  const temporary = path + '.' + randomUUID() + '.tmp';
  const handle = await open(temporary, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(JSON.stringify(entry) + '\n');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function claimJournal(path, receipt) {
  let handle;
  try {
    handle = await open(path, 'wx', 0o600);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let previous;
    try {
      previous = JSON.parse(await readFile(path, 'utf8'));
    } catch {
      throw new Error('A journal exists but is incomplete. Reconcile the outcome before retrying.');
    }
    assert(previous?.manifestSha256 === receipt.manifestSha256,
      'A different manifest is already present for this content and destination.');
    assert(
      ['created', 'verified'].includes(previous.stage) &&
        typeof previous.postId === 'string' && identifier.test(previous.postId),
      'An earlier attempt may have written data. Reconcile the outcome before retrying.'
    );
    return previous;
  }
  try {
    await handle.writeFile(JSON.stringify(receipt) + '\n');
    await handle.sync();
  } finally {
    await handle.close();
  }
  return null;
}

async function handoff(options) {
  assert(options.manifest && options.endpoint, 'Provide --manifest and --endpoint.');
  const endpoint = pilotEndpoint(options.endpoint);
  const { origin } = new URL(endpoint);
  const file = resolve(options.manifest);
  const { manifest, date, manifestSha256 } = await readManifest(file);
  if (options.apply) {
    assert(options['expected-manifest-sha256'] === manifestSha256,
      'The reviewed manifest SHA-256 is required and must match.');
    assert(options['journal-dir'], 'Apply requires a persistent --journal-dir.');
    assert(process.env.POSTIZ_API_KEY?.trim(), 'Set POSTIZ_API_KEY for the isolated Postiz workspace.');
  }
  const media = await approvedMedia(file, manifest);
  const plan = {
    version: 1,
    action: 'draft',
    endpoint,
    contentId: manifest.contentId,
    workspaceId: manifest.workspaceId,
    integrationId: manifest.integrationId,
    provider: manifest.provider,
    mediaSha256: manifest.mediaSha256,
    manifestSha256,
    date,
  };
  if (!options.apply) return { ...plan, stage: 'planned' };

  const request = postizClient(endpoint, process.env.POSTIZ_API_KEY);
  await verifyDestination(request, manifest);

  const directory = resolve(options['journal-dir']);
  const operationId = digest(JSON.stringify([origin, manifest.workspaceId, manifest.integrationId, manifest.contentId]));
  const journal = resolve(directory, operationId + '.json');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const receipt = { ...plan, operationId, stage: 'started' };
  const previous = await claimJournal(journal, receipt);
  if (previous) {
    await verifyDraft(request, manifest, date, previous.postId);
    const verified = { ...previous, stage: 'verified' };
    await saveJournal(journal, verified);
    return { ...verified, reused: true };
  }

  try {
    const form = new FormData();
    form.set('file', media, 'studio-export.mp4');
    const uploaded = await request('POST', '/upload', form);
    assert(
      typeof uploaded?.id === 'string' && identifier.test(uploaded.id) &&
        typeof uploaded.path === 'string',
      'The upload response did not contain a media reference.'
    );
    const uploadUrl = new URL(uploaded.path);
    assert(
      uploadUrl.origin === origin && !uploadUrl.username && !uploadUrl.password &&
        /^\/uploads\/.+\.mp4$/.test(uploadUrl.pathname) && !uploadUrl.search && !uploadUrl.hash,
      'The upload is outside the isolated Postiz media origin.'
    );
    Object.assign(receipt, { stage: 'uploaded', mediaId: uploaded.id });
    await saveJournal(journal, receipt);
    const created = await request('POST', '/posts', JSON.stringify(draftBody(manifest, date, uploaded)));
    assert(
      Array.isArray(created) && created.length === 1 &&
        created[0]?.integration === manifest.integrationId &&
        typeof created[0].postId === 'string' && identifier.test(created[0].postId),
      'The create response did not identify one post on the selected integration.'
    );
    Object.assign(receipt, { stage: 'created', postId: created[0].postId });
    await saveJournal(journal, receipt);
    await verifyDraft(request, manifest, date, receipt.postId);
    receipt.stage = 'verified';
    await saveJournal(journal, receipt);
    return { ...receipt, reused: false };
  } catch (error) {
    // The journal is retained at the last checkpoint. In particular, a failed
    // response is insufficient evidence that the preceding POST had no effect.
    throw new Error(error.message + ' Keep the journal and reconcile before another write (' + operationId + ').');
  }
}

try {
  const { values } = parseArgs({
    options: {
      manifest: { type: 'string' },
      endpoint: { type: 'string' },
      apply: { type: 'boolean', default: false },
      'expected-manifest-sha256': { type: 'string' },
      'journal-dir': { type: 'string' },
    },
  });
  console.log(JSON.stringify(await handoff(values)));
} catch (error) {
  console.error('Shorts draft handoff: ' + error.message);
  process.exitCode = 1;
}
