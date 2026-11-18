import hashlib
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from shorts_draft_fixture_restore import rehearse_fixture_restore


class FixtureRestoreTests(unittest.TestCase):
    def setUp(self):
        work = self.enterContext(TemporaryDirectory(prefix='postiz-draft-smoke-'))
        self.run = Path(work)
        self.uploads = self.run / 'uploads'
        self.uploads.mkdir()
        self.origin = 'http://127.0.0.1:19729'
        self.port = 27891
        self.user = 'fixture_0123456789ab'
        self.password = 'a' * 64
        self.commands = []
        self.restores = []
        pgdata = self.run / 'pgdata'
        pgdata.mkdir()
        (pgdata / 'PG_VERSION').write_text('17\n')
        (pgdata / 'postmaster.pid').write_text(
            f'123\n{pgdata}\n1000\n{self.port}\n\n127.0.0.1\n'
        )

    def rehearse(self, media):
        def run(command, extra=None):
            self.commands.append((command, extra))
            if Path(command[0]).name == 'pg_dump':
                Path(command[command.index('--file') + 1]).write_bytes(b'synthetic-db-archive')

        def verify(database, restored):
            self.restores.append((database, restored))
            return {'ownerDraftsVisible': True, 'otherTenantDraftsHidden': True}

        return rehearse_fixture_restore(
            run=self.run, uploads=self.uploads, media=media, origin=self.origin,
            postgres_bin_dir=Path('/fixture-tools'), database_port=self.port,
            database_user=self.user, database_password=self.password, ffmpeg='/fixture-ffmpeg',
            call=run, verify_restored=verify,
        )

    def test_uses_separate_database_and_restores_media_bytes(self):
        content = b'independent fixture bytes'
        (self.uploads / 'fixture.mp4').write_bytes(content)
        proof = self.rehearse([{'path': f'{self.origin}/uploads/fixture.mp4'}])

        target, restored_uploads = self.restores[0]
        self.assertRegex(target, '^restore_fixture_[0-9a-f]{12}$')
        self.assertNotEqual(restored_uploads, self.uploads)
        self.assertEqual((restored_uploads / 'fixture.mp4').read_bytes(), content)
        self.assertEqual(proof['mediaSha256'], [hashlib.sha256(content).hexdigest()])
        self.assertTrue(proof['ownerDraftsVisible'])
        self.assertTrue(proof['otherTenantDraftsHidden'])
        self.assertGreaterEqual(proof['backupSeconds'], 0)
        self.assertGreaterEqual(proof['restoreAndVerificationSeconds'], 0)
        for command, environment in self.commands[:3]:
            self.assertNotIn(self.password, command)
            self.assertEqual(environment, {'PGPASSWORD': self.password})

    def test_refuses_the_wrong_postgres_port_before_invoking_tools(self):
        self.port += 1
        with self.assertRaisesRegex(RuntimeError, 'fixture PostgreSQL'):
            self.rehearse([])
        self.assertEqual(self.commands, [])

    def test_refuses_media_outside_the_fixture_before_invoking_tools(self):
        (self.run / 'other.mp4').write_bytes(b'outside the uploads root')
        with self.assertRaisesRegex(RuntimeError, 'fixture media'):
            self.rehearse([{'path': f'{self.origin}/uploads/../other.mp4'}])
        self.assertEqual(self.commands, [])

    def test_refuses_media_from_another_origin(self):
        (self.uploads / 'fixture.mp4').write_bytes(b'synthetic video')
        with self.assertRaisesRegex(RuntimeError, 'fixture media'):
            self.rehearse([{'path': 'http://127.0.0.1:9998/uploads/fixture.mp4'}])
        self.assertEqual(self.commands, [])


if __name__ == '__main__':
    unittest.main()
