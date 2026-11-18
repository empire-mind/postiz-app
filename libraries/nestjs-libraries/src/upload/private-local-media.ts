import { constants, realpathSync, statSync } from 'node:fs';
import type { ReadStream } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const contentTypes = new Map([
  ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'], ['png', 'image/png'],
  ['gif', 'image/gif'], ['webp', 'image/webp'], ['avif', 'image/avif'],
  ['bmp', 'image/bmp'], ['tif', 'image/tiff'], ['tiff', 'image/tiff'],
  ['mp4', 'video/mp4'], ['mp3', 'audio/mpeg'], ['m4a', 'audio/mp4'], ['wav', 'audio/wav'],
  ['ogg', 'audio/ogg'], ['oga', 'audio/ogg'], ['opus', 'audio/ogg'],
]);

interface PrivateLocalMedia {
  directory: string;
  urlPrefix: string;
}

export interface PrivateLocalMediaKey {
  year: string;
  month: string;
  day: string;
  file: string;
}

function isWithin(directory: string, path: string) {
  const location = relative(directory, path);
  return location !== '..' && !location.startsWith('..' + sep) && !isAbsolute(location);
}

// Some public mounts are created lazily. Even a missing path may have a
// symlinked parent, so compare its canonical location before enabling writes.
function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(path) === path) throw error;
    return join(canonicalPath(dirname(path)), basename(path));
  }
}

export function getPrivateLocalMedia(env: NodeJS.ProcessEnv = process.env): PrivateLocalMedia | null {
  const configured = env.POSTIZ_PRIVATE_LOCAL_MEDIA_DIRECTORY;
  if (!configured) return null;
  if ((env.STORAGE_PROVIDER || 'local') !== 'local' || !isAbsolute(configured)) {
    throw new Error('Private local media requires local storage and an absolute directory.');
  }

  const directory = realpathSync(configured);
  if (!statSync(directory).isDirectory()) {
    throw new Error('Private local media requires an existing directory.');
  }
  const publicRoots = [
    '/uploads', env.UPLOAD_DIRECTORY, env.NEXT_PUBLIC_UPLOAD_STATIC_DIRECTORY,
    '/app/apps/frontend/public', 'apps/frontend/public', '../frontend/public',
  ];
  for (const root of publicRoots) {
    if (!root) continue;
    const publicDirectory = canonicalPath(resolve(root));
    if (isWithin(publicDirectory, directory) || isWithin(directory, publicDirectory)) {
      throw new Error('Private local media directory must be separate from all public roots.');
    }
  }

  const frontend = new URL(env.FRONTEND_URL || '');
  if (!['http:', 'https:'].includes(frontend.protocol) || frontend.username || frontend.password ||
      frontend.pathname !== '/' || frontend.search || frontend.hash) {
    throw new Error('Private local media requires FRONTEND_URL to be an HTTP(S) origin.');
  }
  return { directory, urlPrefix: frontend.origin + '/api/media/private-local' };
}

function byteWindow(header: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) return null;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix < 1) return null;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) ||
      start >= size || start > requestedEnd) return null;
  return { start, end: Math.min(requestedEnd, size - 1) };
}

export async function openPrivateLocalMedia(
  config: PrivateLocalMedia | null,
  key: PrivateLocalMediaKey,
  range: string | undefined,
  ownsAsset: (path: string) => Promise<boolean>
): Promise<{ status: number; headers: Record<string, string>; stream: ReadStream | null } | null> {
  const filename = /^[a-f0-9]{32,64}\.([a-z0-9]+)$/.exec(key.file);
  const type = filename && contentTypes.get(filename[1]);
  if (!config || !type || !/^\d{4}$/.test(key.year) || !/^\d{2}$/.test(key.month) || !/^\d{2}$/.test(key.day)) return null;

  const segments = [key.year, key.month, key.day, key.file];
  if (!(await ownsAsset(`${config.urlPrefix}/${segments.join('/')}`))) return null;
  const path = join(config.directory, ...segments);
  try {
    // Only the application owns the private volume. Refuse both final and
    // intermediate symlinks rather than using them to reach another asset.
    if ((await realpath(path)) !== path) return null;
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let streaming = false;
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < 1) return null;
      const size = stat.size;
      const headers: Record<string, string> = {
        'Cache-Control': 'private, no-store',
        'Content-Type': type,
        'X-Content-Type-Options': 'nosniff',
        'Accept-Ranges': 'bytes',
      };
      const window = range === undefined ? { start: 0, end: size - 1 } : byteWindow(range, size);
      if (!window) {
        headers['Content-Range'] = `bytes */${size}`;
        headers['Content-Length'] = '0';
        return { status: 416, headers, stream: null };
      }
      const { start, end } = window;
      headers['Content-Length'] = String(end - start + 1);
      if (range !== undefined) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
      const stream = handle.createReadStream({ start, end });
      streaming = true;
      return { status: range === undefined ? 200 : 206, headers, stream };
    } finally {
      if (!streaming) await handle.close();
    }
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes((error as NodeJS.ErrnoException).code || '')) return null;
    throw error;
  }
}
