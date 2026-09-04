import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

if (process.platform !== 'darwin') {
  console.log('isolation probe skipped: macOS sandbox-exec is unavailable');
  process.exit(0);
}
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qa-isolation-'));
const allowed = path.join(dir, 'allowed.txt');
const denied = '/etc/hosts';
await fs.writeFile(allowed, 'allowed');
// macOS needs broad runtime services for arbitrary binaries. This probe proves
// the kernel boundary itself; a production runner still needs a least-privilege profile.
const profile = `(version 1) (allow default) (deny file-read* (subpath "/etc"))`;
const pass = spawnSync('/usr/bin/sandbox-exec', ['-p', profile, '/bin/cat', allowed], { encoding: 'utf8' });
assert.equal(pass.status, 0, pass.stderr);
const blocked = spawnSync('/usr/bin/sandbox-exec', ['-p', profile, '/bin/cat', denied], { encoding: 'utf8' });
assert.notEqual(blocked.status, 0, 'sandbox unexpectedly read an unrelated path');
console.log('macOS sandbox-exec probe passed: run-local read allowed, unrelated path denied');
