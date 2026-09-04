#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const args = process.argv.slice(2);
const targetIndex = args.indexOf('--output');
const output = targetIndex >= 0 ? args[targetIndex + 1] : undefined;
const source = path.resolve(process.cwd(), process.env.QA_DATA_DIR || '.qa-data');

if (!output) {
  console.error('Usage: npm run qa:backup -- --output /absolute/backup-directory');
  process.exitCode = 1;
} else {
  const destination = path.resolve(output);
  if (destination === source || destination.startsWith(`${source}${path.sep}`)) {
    console.error('Backup destination must be outside the active QA data directory.');
    process.exitCode = 1;
  } else {
    try {
      await fs.access(destination);
      console.error(`Refusing to overwrite existing backup destination: ${destination}`);
      process.exitCode = 1;
    } catch {
      await fs.cp(source, destination, { recursive: true, errorOnExist: true });
      console.log(`QA store backup created at ${destination}`);
    }
  }
}
