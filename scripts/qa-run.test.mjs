import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { startQaRun } from './qa-run.mjs';

const seen = [];
const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  seen.push({ path: req.url, body: JSON.parse(Buffer.concat(chunks).toString() || '{}') });
  res.setHeader('content-type', 'application/json');
  if (req.url === '/api/projects/import') return res.end(JSON.stringify({ outcome: 'created', project: { id: 'project-1', name: 'Generic fixture' } }));
  if (req.url === '/api/projects/project-1/runs') return res.end(JSON.stringify({ run: { id: 'run-1', isolationMode: 'unsafe-local' } }));
  res.statusCode = 404; res.end(JSON.stringify({ error: 'not found' }));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'qa-run-test-')), 'qa-system.md');
await fs.writeFile(file, '# Generic\n', 'utf8');
try {
  const result = await startQaRun({ project: file, environment: 'qa', mode: 'web', scope: 'checkout', base: `http://127.0.0.1:${address.port}` });
  assert.equal(result.run.id, 'run-1');
  assert.equal(result.isolationMode, 'unsafe-local');
  assert.equal(seen[0].body.onConflict, 'update');
  assert.deepEqual(seen[1].body.scope, { features: ['checkout'] });
  console.log('qa run API integration test passed');
} finally {
  await new Promise((resolve) => server.close(resolve));
}
