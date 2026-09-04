import fs from 'node:fs/promises';
import path from 'node:path';

export const CONTROL_PLANE_VERSION = 2;

export function recommendProfile(input) {
  const factors = [];
  let score = 0;
  const enabled = Object.values(input.platforms || {}).filter((p) => p?.enabled).length;
  if (enabled > 1) { score += 2; factors.push('multiple platforms'); }
  if (input.project?.expected_lifetime === 'long') { score += 2; factors.push('long-lived product'); }
  if (input.security?.regulated || input.security?.sensitivity === 'high') { score += 3; factors.push('high security or regulatory risk'); }
  for (const key of ['tenancy', 'payments', 'realtime', 'offline']) if (input[key]?.enabled) { score += 1; factors.push(key); }
  if ((input.environments || []).length > 2) { score += 1; factors.push('multiple environments'); }
  const profile = score >= 6 ? 'enterprise' : score >= 2 ? 'production' : 'small';
  return { profile, score, factors: factors.length ? factors : ['low operational complexity'] };
}

export async function discoverProject(directory) {
  const exists = async (name) => fs.access(path.join(directory, name)).then(() => true, () => false);
  const packageJson = await exists('package.json') ? JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8')) : null;
  const files = {
    packageJson: Boolean(packageJson), pubspec: await exists('pubspec.yaml'), android: await exists('build.gradle') || await exists('app/build.gradle'),
    ios: await exists('Podfile') || await exists('*.xcodeproj'), openapi: await exists('openapi.yaml') || await exists('openapi.json'),
    ci: await exists('.github') || await exists('.gitlab-ci.yml'),
  };
  const deps = { ...(packageJson?.dependencies || {}), ...(packageJson?.devDependencies || {}) };
  return {
    existing: Object.values(files).some(Boolean), files,
    inferred: {
      web: Boolean(deps.next || deps.react || deps.vue || deps['@angular/core']),
      backend: Boolean(deps.express || deps.fastify || deps.next), flutter: files.pubspec,
      android_native: files.android, ios_native: files.ios, apiContract: files.openapi,
      testInfrastructure: Boolean(deps.playwright || deps.vitest || deps.jest),
    },
  };
}

export function normalizeProject(input) {
  const out = structuredClone(input);
  const recommendation = recommendProfile(out);
  const override = out.project?.profile;
  out.project ||= {};
  out.project.profile = override || recommendation.profile;
  out.project.profile_recommendation = recommendation;
  out.control_plane_version = CONTROL_PLANE_VERSION;
  return out;
}

export function validateControlPlane(input, schema) {
  const errors = [];
  const validate = (value, rule, at = '$') => {
    if (rule.$ref) return validate(value, schema.$defs?.[rule.$ref.split('/').pop()] || {}, at);
    if (rule.required) for (const key of rule.required) if (value?.[key] === undefined) errors.push(`${at}.${key} is required`);
    if (rule.enum && !rule.enum.includes(value)) errors.push(`${at} must be one of ${rule.enum.join(', ')}`);
    if (rule.type === 'object' && (!value || typeof value !== 'object' || Array.isArray(value))) errors.push(`${at} must be an object`);
    if (rule.type === 'array' && !Array.isArray(value)) errors.push(`${at} must be an array`);
    if (rule.type === 'string' && typeof value !== 'string') errors.push(`${at} must be a string`);
    if (rule.type === 'boolean' && typeof value !== 'boolean') errors.push(`${at} must be a boolean`);
    if (rule.minLength && typeof value === 'string' && value.length < rule.minLength) errors.push(`${at} is too short`);
    if (rule.minItems && Array.isArray(value) && value.length < rule.minItems) errors.push(`${at} needs at least ${rule.minItems} item(s)`);
    if (rule.properties && value && typeof value === 'object') for (const [key, child] of Object.entries(rule.properties)) if (value[key] !== undefined) validate(value[key], child, `${at}.${key}`);
    if (rule.items && Array.isArray(value)) value.forEach((item, i) => validate(item, rule.items, `${at}[${i}]`));
    if (rule.additionalProperties && typeof rule.additionalProperties === 'object' && value && typeof value === 'object') for (const [key, child] of Object.entries(value)) if (!rule.properties?.[key]) validate(child, rule.additionalProperties, `${at}.${key}`);
  };
  validate(input, schema);
  if (errors.length) throw new Error(`Control-plane schema validation failed: ${errors.join('; ')}`);
  return input;
}

export function migrateControlPlane(input) {
  const version = input.control_plane_version || 1;
  if (version > CONTROL_PLANE_VERSION) throw new Error(`Control plane v${version} is newer than this bootstrapper.`);
  if (version === CONTROL_PLANE_VERSION) return input;
  const migrated = structuredClone(input);
  migrated.control_plane_version = CONTROL_PLANE_VERSION;
  migrated.project ||= {};
  migrated.project.profile_recommendation ||= recommendProfile(migrated);
  return migrated;
}
