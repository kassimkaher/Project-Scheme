import fs from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

const skillsRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../skills');
const names = [];
for (const name of await fs.readdir(skillsRoot)) {
  if (await fs.access(path.join(skillsRoot, name, 'SKILL.md')).then(() => true, () => false)) names.push(name);
}
const errors = [];
for (const name of names) {
  const directory = path.join(skillsRoot, name);
  const skill = await fs.readFile(path.join(directory, 'SKILL.md'), 'utf8').catch(() => '');
  const match = skill.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) { errors.push(`${name}: missing YAML frontmatter`); continue; }
  const frontmatter = parseYaml(match[1]);
  if (!frontmatter || Object.keys(frontmatter).sort().join(',') !== 'description,name') errors.push(`${name}: frontmatter must contain exactly name and description`);
  if (frontmatter?.name !== name) errors.push(`${name}: frontmatter name mismatch`);
  if (typeof frontmatter?.description !== 'string' || frontmatter.description.length < 40) errors.push(`${name}: description is too weak`);
  await fs.access(path.join(directory, 'agents/openai.yaml')).catch(() => errors.push(`${name}: missing agents/openai.yaml`));
  if (skill.length < 220) errors.push(`${name}: guidance is too short`);
}
if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; } else console.log(`validated ${names.length} structured Skills`);
