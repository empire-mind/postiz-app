import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const smoke = fileURLToPath(new URL('./shorts-draft-native-smoke.py', import.meta.url));

function runPreflight(interfaces, uid) {
  // Use synthetic process observations so these safety tests work even on a
  // runner already inside a loopback-only namespace. No service is started.
  const launcher = `
from pathlib import Path
import os
import runpy
import sys

source, interfaces, uid = sys.argv[1:]
read_text = Path.read_text
def read_interfaces(path, *args, **kwargs):
    if path == Path('/proc/self/net/dev'):
        return interfaces
    return read_text(path, *args, **kwargs)
Path.read_text = read_interfaces
os.geteuid = lambda: int(uid)
sys.argv = [source, '--postgres-bin-dir', '/nonexistent-smoke-fixture']
runpy.run_path(source, run_name='__main__')
`;
  return spawnSync('python3', ['-c', launcher, smoke, interfaces, String(uid)], {
    encoding: 'utf8',
  });
}

test('native smoke refuses network egress before resolving service binaries', () => {
  const run = runPreflight('header\nheader\n lo: 0\n eth0: 0\n', 1000);
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stderr, /requires a loopback-only Linux network namespace/);
  assert.doesNotMatch(run.stderr, /nonexistent-smoke-fixture/);
});

test('native smoke refuses root instead of initialising PostgreSQL as root', () => {
  const run = runPreflight('header\nheader\n lo: 0\n', 0);
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stderr, /requires an unprivileged user/);
  assert.doesNotMatch(run.stderr, /nonexistent-smoke-fixture/);
});
