#!/usr/bin/env node
/**
 * Development screenshot tool. Uses the locally installed playwright-core and
 * Chromium build, so it needs no network and no MCP server.
 *
 *   node scripts/screenshot.mjs <outDir> <name>=<url> [<name>=<url> ...]
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { chromium } = require_('playwright-core');

const [outDir, ...specs] = process.argv.slice(2);
if (!outDir || !specs.length) {
  console.error('usage: screenshot.mjs <outDir> <name>=<url> [...]');
  process.exit(2);
}
await fs.mkdir(outDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

for (const spec of specs) {
  const i = spec.indexOf('=');
  const name = spec.slice(0, i);
  const url = spec.slice(i + 1);
  // Allow "name=url|waitForSelectorOrDelayMs"
  const [target, extra] = url.split('|');
  try {
    await page.goto(target, { waitUntil: 'networkidle', timeout: 45_000 });
    if (extra) {
      if (/^\d+$/.test(extra)) await page.waitForTimeout(Number(extra));
      else await page.waitForSelector(extra, { timeout: 20_000 }).catch(() => {});
    }
    await page.waitForTimeout(500);
    const file = path.join(outDir, `${name}.png`);
    await page.screenshot({ path: file, fullPage: true });
    const { width, height } = await page.evaluate(() => ({
      width: document.documentElement.scrollWidth,
      height: document.documentElement.scrollHeight,
    }));
    const overflow = width > 1440 + 2;
    console.log(`✓ ${name}  ${file}  (${width}×${height}${overflow ? '  ⚠ HORIZONTAL OVERFLOW' : ''})`);
  } catch (e) {
    console.log(`✗ ${name}  ${target}  ${e.message}`);
  }
}

if (errors.length) {
  console.log(`\nconsole errors (${errors.length}):`);
  for (const e of [...new Set(errors)].slice(0, 10)) console.log(`  ${e}`);
}
await browser.close();
