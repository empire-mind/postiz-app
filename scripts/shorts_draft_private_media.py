"""Exercise private media through the real Postiz API in the isolated fixture."""

from base64 import urlsafe_b64encode
import hashlib
import hmac
from http.client import HTTPConnection
import json
import re


PRIVATE_MEDIA_PREFIX = '/api/media/private-local/'
OWNER = 'fixture-workspace-browser'
OTHER = 'fixture-other-workspace-browser'
SEED_BROWSER_USERS = '''
const { PrismaClient } = require('@prisma/client');
const db = new PrismaClient();
(async () => {
  for (const organizationId of ['fixture-workspace', 'fixture-other-workspace']) {
    const id = organizationId + '-browser';
    await db.user.create({ data: {
      id, email: id + '@example.invalid', timezone: 0, providerName: 'LOCAL',
      organizations: { create: { organizationId } },
    } });
  }
})().finally(() => db.$disconnect()).catch(() => {
  console.error('Could not create isolated browser fixture users');
  process.exitCode = 1;
});
'''


def _session(user_id, fixture_key):
    def encode(data):
        return urlsafe_b64encode(data).rstrip(b'=').decode('ascii')

    header = encode(b'{"alg":"HS256","typ":"JWT"}')
    payload = encode(json.dumps({'id': user_id}).encode())
    unsigned = f'{header}.{payload}'
    signature = hmac.digest(fixture_key.encode(), unsigned.encode(), 'sha256')
    return f'auth={unsigned}.{encode(signature)}'


def verify_private_media(*, call, node, backend_port, asset_path, fixture_key, expected_digest, public_uploads):
    name = asset_path.removeprefix(PRIVATE_MEDIA_PREFIX)
    if (not asset_path.startswith(PRIVATE_MEDIA_PREFIX)
            or not re.fullmatch(r'\d{4}/\d{2}/\d{2}/[a-f0-9]{32,64}\.mp4', name)
            or (public_uploads / name).exists()):
        raise RuntimeError('fixture media did not stay outside the public uploads directory')

    call([node, '-e', SEED_BROWSER_USERS])
    backend_path = asset_path.removeprefix('/api')
    owner = {'Cookie': _session(OWNER, fixture_key)}
    other_workspace = {'Cookie': _session(OTHER, fixture_key), 'Showorg': 'fixture-workspace'}

    def request(path, headers, expected_status):
        connection = HTTPConnection('127.0.0.1', backend_port, timeout=5)
        try:
            connection.request('GET', path, headers=headers)
            response = connection.getresponse()
            if response.status != expected_status:
                raise RuntimeError(f'private media expected HTTP {expected_status}, got {response.status}')
            data = response.read(2_000_001)
            if len(data) > 2_000_000:
                raise RuntimeError('private media fixture exceeded its response size budget')
            return response.headers, data
        finally:
            connection.close()

    headers, body = request(backend_path, owner, 200)
    if (headers.get('Cache-Control') != 'private, no-store'
            or hashlib.sha256(body).hexdigest() != expected_digest):
        raise RuntimeError('private media owner response had unexpected cache headers or bytes')
    range_headers, partial = request(backend_path, {**owner, 'Range': 'bytes=0-15'}, 206)
    if (range_headers.get('Cache-Control') != 'private, no-store'
            or range_headers.get('Content-Type') != 'video/mp4'
            or range_headers.get('X-Content-Type-Options') != 'nosniff'
            or range_headers.get('Accept-Ranges') != 'bytes'
            or range_headers.get('Content-Range') != f'bytes 0-15/{len(body)}'
            or len(partial) != 16 or partial != body[:16]):
        raise RuntimeError('private media returned an invalid byte range')
    invalid_headers, invalid_body = request(backend_path, {**owner, 'Range': f'bytes={len(body)}-'}, 416)
    if invalid_headers.get('Content-Range') != f'bytes */{len(body)}' or invalid_body:
        raise RuntimeError('private media returned an invalid unsatisfiable range response')
    request(backend_path, {'Range': 'bytes=0-15'}, 401)
    request(backend_path, {**other_workspace, 'Range': 'bytes=0-15'}, 404)
    request('/uploads/' + name, {}, 404)
    return {
        'ownerHttp': 200, 'ownerRangeHttp': 206, 'anonymousHttp': 401, 'otherTenantHttp': 404,
        'backendPublicAliasHttp': 404, 'unsatisfiableRangeHttp': 416, 'ownerMediaDigestVerified': True,
        'cacheControl': 'private, no-store',
    }
