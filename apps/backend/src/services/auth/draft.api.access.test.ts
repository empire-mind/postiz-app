import { createHash } from 'node:crypto';
import {
  allowsDraftApiRequest,
  authorizedDraftApiOrganization,
} from './draft.api.access';

const token = 'pzd_' + 'a'.repeat(64);
const digest = createHash('sha256').update(token).digest('hex');
const organization = 'fixture-workspace';

function draft() {
  return {
    type: 'draft',
    date: '2031-07-15T11:30:00.000Z',
    shortLink: false,
    tags: [],
    creationMethod: 'CLI',
    posts: [
      {
        type: 'draft',
        integration: { id: 'fixture-channel' },
        value: [
          {
            content: '<p>Reviewed draft</p>',
            image: [
              {
                id: 'fixture-media',
                path: 'http://127.0.0.1:4000/uploads/fixture.mp4',
              },
            ],
          },
        ],
      },
    ],
  };
}

function allowed(
  method: string,
  originalUrl: string,
  body?: unknown,
  headers = {}
) {
  return allowsDraftApiRequest({ method, originalUrl, body, headers });
}

test('a configured digest authorizes only its scoped credential and workspace', () => {
  expect(authorizedDraftApiOrganization(token, digest, organization)).toBe(
    organization
  );
  expect(
    authorizedDraftApiOrganization(token, undefined, organization)
  ).toBeUndefined();
  expect(
    authorizedDraftApiOrganization(token, digest, undefined)
  ).toBeUndefined();
  expect(
    authorizedDraftApiOrganization(token, 'f'.repeat(64), organization)
  ).toBeUndefined();
  expect(
    authorizedDraftApiOrganization(token, 'invalid', organization)
  ).toBeUndefined();
});

test('the draft principal can read its identity, integrations and drafts, upload and create a new draft', () => {
  expect(allowed('GET', '/public/v1/me')).toBe(true);
  expect(allowed('GET', '/public/v1/integrations')).toBe(true);
  expect(
    allowed('GET', '/public/v1/posts?startDate=2031-07-15&endDate=2031-07-16')
  ).toBe(true);
  expect(allowed('POST', '/public/v1/upload')).toBe(true);
  expect(allowed('POST', '/public/v1/posts', draft())).toBe(true);
});

test('a scoped credential cannot change its effective workspace or operate on deleted workspaces', () => {
  expect(
    allowed('GET', '/public/v1/me', undefined, { 'x-postiz-org': 'other' })
  ).toBe(false);
  expect(
    allowed('GET', '/public/v1/me', undefined, {
      'x-postiz-include-deleted': 'true',
    })
  ).toBe(false);
});

test('the draft principal cannot call unrelated endpoints or non-create write methods', () => {
  for (const [method, route] of [
    ['GET', '/public/v1/debug/account'],
    ['GET', '/public/v1/media'],
    ['POST', '/public/v1/upload-from-url'],
    ['POST', '/public/v1/posts/end'],
    ['PATCH', '/public/v1/posts'],
    ['PUT', '/public/v1/posts/fixture-post/settings'],
    ['DELETE', '/public/v1/posts/fixture-post'],
    ['POST', '/public/v1/posts?refresh=fixture'],
  ]) {
    expect(allowed(method, route, draft())).toBe(false);
  }
});

test('draft creation rejects publish and schedule types, existing post identities and other controls', () => {
  for (const type of ['schedule', 'now', 'publish', 'update']) {
    expect(allowed('POST', '/public/v1/posts', { ...draft(), type })).toBe(
      false
    );
  }
  const otherType = draft();
  otherType.posts[0].type = 'schedule';
  expect(allowed('POST', '/public/v1/posts', otherType)).toBe(false);

  const existing = draft();
  Object.assign(existing.posts[0].value[0], { id: 'existing-scheduled-post' });
  expect(allowed('POST', '/public/v1/posts', existing)).toBe(false);
  expect(
    allowed('POST', '/public/v1/posts', { ...draft(), shortLink: true })
  ).toBe(false);
  expect(
    allowed('POST', '/public/v1/posts', { ...draft(), keepGroup: true })
  ).toBe(false);
  expect(allowed('POST', '/public/v1/posts', { ...draft(), posts: [] })).toBe(
    false
  );
});
