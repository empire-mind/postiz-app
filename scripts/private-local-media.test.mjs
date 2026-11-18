import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  createThumbnailUploadForm,
  getThumbnailVideoSource,
} from '../apps/frontend/src/components/launches/helpers/thumbnail.media.ts';
import {
  getPrivateLocalMedia,
  openPrivateLocalMedia,
} from '../libraries/nestjs-libraries/src/upload/private-local-media.ts';

const object = { year: '2026', month: '11', day: '19', file: 'a'.repeat(32) + '.mp4' };
const objectPath = join(...Object.values(object));
const origin = 'http://127.0.0.1:4007';
const url = `${origin}/api/media/private-local/${Object.values(object).join('/')}`;
const asset = Buffer.from('fixture');

test('the thumbnail scrubber loads a private MP4 directly from the browser origin', () => {
  const assetPath = new URL(url).pathname;
  const backendUrl = 'https://api.example.invalid';
  const hostedOrigin = 'https://postiz.example.invalid';

  assert.equal(getThumbnailVideoSource(url, backendUrl, origin), assetPath);
  assert.equal(getThumbnailVideoSource(hostedOrigin + assetPath, backendUrl, hostedOrigin), assetPath);
});

test('the thumbnail scrubber keeps using the proxy for external and non-private media', () => {
  const backendUrl = `${origin}/api`;
  const assetPath = new URL(url).pathname;

  for (const source of [
    'https://media.example.invalid/video.mp4',
    `https://media.example.invalid${assetPath}`,
    `http://127.0.0.1:4008${assetPath}`,
    `${origin}/uploads/${object.file}`,
    `${origin}/api/media/private-local/video.mp4`,
    `http://user@127.0.0.1:4007${assetPath}`,
    `${url}?download=true`,
    `${url}#t=1`,
    'not-a-url',
  ]) {
    assert.equal(
      getThumbnailVideoSource(source, backendUrl, origin),
      `${backendUrl}/public/stream?url=${encodeURIComponent(source)}`
    );
  }
});

test('a captured private thumbnail is registered to the workspace on upload', async () => {
  const frame = new Blob(['fixture frame'], { type: 'image/jpeg' });
  const privateForm = createThumbnailUploadForm(frame, url, origin);
  const publicForm = createThumbnailUploadForm(frame, 'https://media.example.invalid/video.mp4', origin);

  assert.equal(privateForm.get('preventSave'), null);
  assert.equal(publicForm.get('preventSave'), 'true');
  for (const form of [privateForm, publicForm]) {
    const file = form.get('file');
    assert.equal(file.name, 'media.jpg');
    assert.equal(file.type, 'image/jpeg');
    assert.equal(await file.text(), 'fixture frame');
  }
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'postiz-private-media-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const privateDirectory = join(root, 'private');
  const publicDirectory = join(root, 'public');
  await mkdir(join(privateDirectory, object.year, object.month, object.day), { recursive: true });
  await mkdir(publicDirectory);
  await writeFile(join(privateDirectory, objectPath), asset);
  const env = {
    STORAGE_PROVIDER: 'local',
    FRONTEND_URL: origin,
    POSTIZ_PRIVATE_LOCAL_MEDIA_DIRECTORY: privateDirectory,
    UPLOAD_DIRECTORY: publicDirectory,
  };
  return { privateDirectory, publicDirectory, env };
}

test('public local storage stays the default and private storage must be outside public roots', async (t) => {
  const { env, publicDirectory, privateDirectory } = await fixture(t);
  assert.equal(getPrivateLocalMedia({ ...env, POSTIZ_PRIVATE_LOCAL_MEDIA_DIRECTORY: undefined }), null);
  assert.equal(getPrivateLocalMedia(env).directory, privateDirectory);
  assert.throws(() => getPrivateLocalMedia({ ...env, POSTIZ_PRIVATE_LOCAL_MEDIA_DIRECTORY: publicDirectory }), /public/i);
  const alias = join(publicDirectory, 'private-alias');
  await symlink(privateDirectory, alias, 'dir');
  assert.throws(() => getPrivateLocalMedia({ ...env, UPLOAD_DIRECTORY: alias }), /public/i);
});

test('only an owned item can open and successful ranges are private and non-cacheable', async (t) => {
  const { env } = await fixture(t);
  const config = getPrivateLocalMedia(env);
  assert.equal(await openPrivateLocalMedia(config, object, 'bytes=0-1', async () => false), null);

  const result = await openPrivateLocalMedia(config, object, 'bytes=0-1', async (path) => path === url);
  assert.equal(result.status, 206);
  assert.equal(result.headers['Cache-Control'], 'private, no-store');
  assert.equal(result.headers['Content-Type'], 'video/mp4');
  assert.equal(result.headers['Content-Range'], 'bytes 0-1/7');
  assert.equal(result.headers['Accept-Ranges'], 'bytes');
  const parts = [];
  for await (const part of result.stream) parts.push(part);
  assert.deepEqual(Buffer.concat(parts), asset.subarray(0, 2));
});

test('invalid ranges, invalid keys and symlinked assets fail closed', async (t) => {
  const { env, privateDirectory, publicDirectory } = await fixture(t);
  const config = getPrivateLocalMedia(env);
  const invalid = await openPrivateLocalMedia(config, object, 'bytes=100-200', async () => true);
  assert.equal(invalid.status, 416);
  assert.equal(invalid.headers['Content-Range'], 'bytes */7');
  assert.equal(invalid.headers['Cache-Control'], 'private, no-store');
  assert.equal(invalid.stream, null);
  assert.equal(await openPrivateLocalMedia(config, { ...object, year: '..' }, undefined, async () => true), null);
  const other = { ...object, file: 'b'.repeat(32) + '.mp4' };
  const target = join(publicDirectory, 'unrelated.mp4');
  await writeFile(target, asset);
  await symlink(target, join(privateDirectory, ...Object.values(other)));
  assert.equal(await openPrivateLocalMedia(config, other, undefined, async () => true), null);
});
