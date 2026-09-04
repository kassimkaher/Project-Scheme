#!/usr/bin/env node
/**
 * Development reset.
 *
 * The orchestrator ships with no project data, but a development machine can
 * accumulate imported projects. This gives a deliberate way back to a clean
 * generic state without ever silently discarding work: every project is archived
 * first, and you must pass --yes to actually move anything.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const dataDir = path.resolve(process.cwd(), process.env.QA_DATA_DIR || '.qa-data');
const args = new Set(process.argv.slice(2));
const confirmed = args.has('--yes');
const purge = args.has('--purge');

async function listDirs(p) {
  try {
    return (await fs.readdir(p, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch { return []; }
}

const projectsDir = path.join(dataDir, 'projects');
const ids = await listDirs(projectsDir);

if (!ids.length) {
  console.log(`Nothing to reset — ${dataDir} holds no projects. The app already starts generic.`);
  process.exit(0);
}

console.log(`Data directory: ${dataDir}`);
for (const id of ids) {
  let name = '(unreadable)';
  let runs = 0;
  try {
    name = JSON.parse(await fs.readFile(path.join(projectsDir, id, 'project.json'), 'utf8')).name;
  } catch { /* pre-migration or damaged */ }
  runs = (await listDirs(path.join(projectsDir, id, 'runs'))).length;
  console.log(`  • ${id}  ${name}  (${runs} run${runs === 1 ? '' : 's'})`);
}

if (!confirmed) {
  console.log('\nDry run. Nothing was changed.');
  console.log('  node scripts/reset-dev.mjs --yes           archive every project to .qa-data-archive-<timestamp>');
  console.log('  node scripts/reset-dev.mjs --yes --purge   delete them outright (irreversible)');
  process.exit(0);
}

if (purge) {
  for (const id of ids) await fs.rm(path.join(projectsDir, id), { recursive: true, force: true });
  await fs.rm(path.join(dataDir, 'meta.json'), { force: true });
  console.log(`\nDeleted ${ids.length} project(s). The app now starts with an empty library.`);
} else {
  const archive = path.resolve(process.cwd(), `.qa-data-archive-${Date.now()}`);
  await fs.mkdir(path.join(archive, 'projects'), { recursive: true });
  for (const id of ids) await fs.rename(path.join(projectsDir, id), path.join(archive, 'projects', id));
  await fs.rm(path.join(dataDir, 'meta.json'), { force: true });
  console.log(`\nArchived ${ids.length} project(s) to ${archive}`);
  console.log('Nothing was deleted. Move a project directory back into .qa-data/projects/ to restore it.');
}
