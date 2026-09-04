#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

function value(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function usage() {
  return 'Usage: npm run qa:run -- --project .qa/qa-system.md --environment qa --mode web [--scope checkout] [--base http://127.0.0.1:4100]';
}

async function request(base, pathname, options) {
  const response = await fetch(new URL(pathname, base), options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body.error || `QA API returned ${response.status}`), { status: response.status, body });
  return body;
}

export async function startQaRun({ project, environment, mode, scope, base = 'http://127.0.0.1:4100' }) {
  const raw = await fs.readFile(path.resolve(project), 'utf8');
  const imported = await request(base, '/api/projects/import', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ raw, filename: path.basename(project), onConflict: 'update' }),
  });
  const run = await request(base, `/api/projects/${encodeURIComponent(imported.project.id)}/runs`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ envId: environment, mode, scope: scope ? { features: [scope] } : undefined }),
  });
  return { project: imported.project, run: run.run, isolationMode: run.run.isolationMode || 'unsafe-local' };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const project = value(args, '--project');
  const environment = value(args, '--environment');
  const mode = value(args, '--mode');
  if (!project || !environment || !mode || !['analyze', 'api', 'web', 'full'].includes(mode)) {
    console.error(usage()); process.exitCode = 1;
  } else {
    try {
      const result = await startQaRun({ project, environment, mode, scope: value(args, '--scope'), base: value(args, '--base') });
      console.log(`QA run started: ${result.run.id} for ${result.project.name}`);
      console.log(`Isolation mode: ${result.isolationMode} (not sandboxed)`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1;
    }
  }
}
