import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';

export const draftApiPrincipal = Symbol('draftApiPrincipal');
export type DraftApiRequest = Request & { [draftApiPrincipal]?: true };

export function authorizedDraftApiOrganization(
  credential: string,
  digest: string | undefined,
  organization: string | undefined
): string | undefined {
  if (
    !/^pzd_[a-f0-9]{64}$/.test(credential) ||
    !digest ||
    !/^[a-f0-9]{64}$/.test(digest) ||
    !organization?.trim()
  ) {
    return undefined;
  }

  const supplied = createHash('sha256').update(credential).digest();
  return timingSafeEqual(supplied, Buffer.from(digest, 'hex'))
    ? organization.trim()
    : undefined;
}

function hasOnlyKeys<T extends string>(
  value: unknown,
  keys: readonly T[]
): value is Record<T, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function isSingleNewDraft(body: unknown): boolean {
  if (
    !hasOnlyKeys(body, [
      'type',
      'date',
      'shortLink',
      'tags',
      'creationMethod',
      'posts',
    ]) ||
    body.type !== 'draft' ||
    typeof body.date !== 'string' ||
    body.shortLink !== false ||
    !Array.isArray(body.tags) ||
    body.tags.length !== 0 ||
    (body.creationMethod !== 'CLI' && body.creationMethod !== 'API') ||
    !Array.isArray(body.posts) ||
    body.posts.length !== 1
  ) {
    return false;
  }

  const [post] = body.posts;
  if (
    !hasOnlyKeys(post, ['type', 'integration', 'value']) ||
    post.type !== 'draft' ||
    !hasOnlyKeys(post.integration, ['id']) ||
    typeof post.integration.id !== 'string' ||
    !Array.isArray(post.value) ||
    post.value.length !== 1
  ) {
    return false;
  }

  const [value] = post.value;
  if (
    !hasOnlyKeys(value, ['content', 'image']) ||
    typeof value.content !== 'string' ||
    !Array.isArray(value.image) ||
    value.image.length !== 1
  ) {
    return false;
  }

  const [media] = value.image;
  return (
    hasOnlyKeys(media, ['id', 'path']) &&
    typeof media.id === 'string' &&
    typeof media.path === 'string'
  );
}

export function allowsDraftApiRequest(
  request: Pick<Request, 'method' | 'originalUrl' | 'headers'> & {
    body?: unknown;
  }
): boolean {
  const { method, originalUrl, headers, body } = request;
  if ('x-postiz-org' in headers || 'x-postiz-include-deleted' in headers) {
    return false;
  }

  const [path, query] = originalUrl.split('?', 2);
  if (method === 'GET') {
    return (
      path === '/public/v1/posts' ||
      (query === undefined &&
        (path === '/public/v1/me' || path === '/public/v1/integrations'))
    );
  }

  return (
    method === 'POST' &&
    query === undefined &&
    (path === '/public/v1/upload' ||
      (path === '/public/v1/posts' && isSingleNewDraft(body)))
  );
}
