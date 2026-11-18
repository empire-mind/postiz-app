"""Rehearse metadata and media recovery inside the disposable draft smoke fixture."""

import hashlib
import re
import secrets
import shutil
import time
from pathlib import Path
from urllib.parse import urlsplit


def fixture_media(uploads, media, origin):
    paths = []
    origin_url = urlsplit(origin)
    for row in media:
        url = urlsplit(row['path'])
        prefix = next((item for item in ('/uploads/', '/api/media/private-local/')
                       if url.path.startswith(item)), None)
        if (not prefix or url.query or url.fragment or url.username or url.password
                or (url.scheme, url.netloc) != (origin_url.scheme, origin_url.netloc)):
            raise RuntimeError('restore accepts only local fixture media')
        relative = Path(url.path.removeprefix(prefix))
        resolved = (uploads / relative).resolve()
        if ('..' in relative.parts or not resolved.is_relative_to(uploads)
                or resolved.suffix.lower() != '.mp4' or not resolved.is_file()):
            raise RuntimeError('restore accepts only files in the fixture media directory')
        paths.append((relative, resolved))
    if not paths:
        raise RuntimeError('restore requires fixture media to verify')
    return paths


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def rehearse_fixture_restore(*, run, uploads, media, origin, postgres_bin_dir,
                             database_port, database_user, database_password, ffmpeg,
                             call, verify_restored):
    """Restore only the fresh cluster and assets created by the local smoke run."""
    run = run.resolve()
    uploads = uploads.resolve()
    pgdata = run / 'pgdata'
    if (not run.name.startswith('postiz-draft-smoke-') or uploads == run
            or not uploads.is_relative_to(run) or pgdata.is_symlink()
            or not re.fullmatch(r'fixture_[0-9a-f]{12}', database_user)
            or not re.fullmatch(r'[0-9a-f]{64}', database_password)
            or not (pgdata / 'PG_VERSION').is_file()):
        raise RuntimeError('restore requires a disposable fixture PostgreSQL cluster and media root')
    instance = (pgdata / 'postmaster.pid').read_text().splitlines()
    if (len(instance) < 6 or instance[1] != str(pgdata)
            or instance[3] != str(database_port) or instance[5] != '127.0.0.1'):
        raise RuntimeError('restore could not verify the fixture PostgreSQL instance')
    paths = fixture_media(uploads, media, origin)

    work = run / 'restore-check'
    work.mkdir(mode=0o700)
    archive = work / 'metadata.dump'
    snapshot = work / 'media-backup'
    restored_uploads = work / 'restored-media'
    connection = ['--host', '127.0.0.1', '--port', str(database_port),
                  '--username', database_user, '--no-password']
    credentials = {'PGPASSWORD': database_password}
    target = 'restore_fixture_' + secrets.token_hex(6)

    started = time.monotonic()
    call([str(postgres_bin_dir / 'pg_dump'), *connection, '--format=custom',
          '--file', str(archive), '--dbname', 'postgres'], credentials)
    expected_digests = []
    for relative, source in paths:
        held = snapshot / relative
        held.parent.mkdir(parents=True, exist_ok=True)
        expected_digests.append(digest(source))
        shutil.copy2(source, held)
    backed_up = time.monotonic()

    call([str(postgres_bin_dir / 'createdb'), *connection, '--maintenance-db', 'postgres',
          target], credentials)
    call([str(postgres_bin_dir / 'pg_restore'), *connection, '--exit-on-error', '--no-owner',
          '--no-privileges', '--dbname', target, str(archive)], credentials)
    shutil.copytree(snapshot, restored_uploads)
    for (relative, _), expected in zip(paths, expected_digests):
        asset = restored_uploads / relative
        if digest(asset) != expected:
            raise RuntimeError('restored fixture media failed its digest check')
        call([ffmpeg, '-v', 'error', '-xerror', '-i', str(asset), '-f', 'null', '-'])
    visibility = verify_restored(target, restored_uploads)

    return {
        **visibility,
        'scope': 'local-quiescent-synthetic-fixture',
        'backupSeconds': round(backed_up - started, 3),
        'restoreAndVerificationSeconds': round(time.monotonic() - backed_up, 3),
        'mediaSha256': expected_digests,
    }
