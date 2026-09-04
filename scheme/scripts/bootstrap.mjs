#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");

const profiles = {
  small: {
    architecture: "simple_feature_first",
    gates: ["focused tests", "focused QA when enabled"],
  },
  production: {
    architecture: "feature_first",
    gates: ["contract checks", "integration QA", "release checklist"],
  },
  enterprise: {
    architecture: "modular_bounded_contexts",
    gates: ["contract checks", "security review", "integration QA", "release gate"],
  },
};

const skillRules = [
  ["project-bootstrap", () => true],
  ["backend-api", (a) => a.platforms?.backend?.enabled],
  ["database-engineering", (a) => Boolean(a.database?.engine)],
  ["web-application", (a) => a.platforms?.web?.enabled],
  ["flutter-mobile", (a) => a.platforms?.flutter?.enabled],
  ["android-native", (a) => a.platforms?.android_native?.enabled],
  ["ios-native", (a) => a.platforms?.ios_native?.enabled],
  ["security-baseline", (a) => a.security?.sensitivity === "high" || a.security?.regulated || a.project?.profile === "enterprise"],
  ["qa-integration", (a) => a.qa?.enabled],
  ["release-readiness", (a) => a.project?.profile !== "small" || a.release?.required],
];

function fail(message) {
  throw new Error(`Invalid project answers: ${message}`);
}

export function validateAnswers(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("expected an object");
  const { project, platforms = {}, database = {}, environments = [], qa = {}, security = {} } = input;
  if (!project || typeof project.name !== "string" || !project.name.trim()) fail("project.name is required");
  if (!['small', 'production', 'enterprise'].includes(project.profile)) fail("project.profile must be small, production, or enterprise");
  if (!project.type || typeof project.type !== "string") fail("project.type is required");
  if (!Array.isArray(environments) || environments.length === 0) fail("environments must contain at least one environment");
  for (const [name, platform] of Object.entries(platforms)) {
    if (typeof platform !== "object" || typeof platform.enabled !== "boolean") fail(`platforms.${name}.enabled must be boolean`);
  }
  if (database.engine !== undefined && typeof database.engine !== "string") fail("database.engine must be a string");
  if (typeof qa.enabled !== "boolean") fail("qa.enabled must be boolean");
  if (security.sensitivity && !['low', 'medium', 'high'].includes(security.sensitivity)) fail("security.sensitivity must be low, medium, or high");
  return input;
}

export function selectSkills(answers) {
  return skillRules.filter(([, applies]) => applies(answers)).map(([skill]) => skill);
}

function profileFor(input) {
  return profiles[input.project.profile];
}

function template(value, answers, skills) {
  return value
    .replaceAll("{{PROJECT_NAME}}", answers.project.name)
    .replaceAll("{{PROFILE}}", answers.project.profile)
    .replaceAll("{{ARCHITECTURE}}", profileFor(answers).architecture)
    .replaceAll("{{SKILLS}}", skills.map((skill) => `- ${skill}`).join("\n"));
}

async function writeFile(destination, content, overwrite = false) {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  if (!overwrite) {
    try { await fs.access(destination); return; } catch { /* create below */ }
  }
  await fs.writeFile(destination, content, "utf8");
}

function projectYaml(answers) {
  return stringifyYaml({
    project: answers.project,
    platforms: answers.platforms,
    database: answers.database,
    architecture: { style: profileFor(answers).architecture },
    environments: answers.environments,
    mobile: answers.mobile ?? {},
    qa: answers.qa,
    contracts: answers.contracts ?? {},
  });
}

function qaSystem(answers) {
  const environment = answers.environments[0];
  return `# ${answers.project.name} QA definition\n\n\`\`\`qa-config\nversion: 1\nprojectId: ${answers.project.id ?? answers.project.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}\nsystem:\n  name: ${JSON.stringify(answers.project.name)}\nenvironments:\n  - id: ${environment}\n    label: ${environment}\n    kind: ${environment}\n    # Replace this local placeholder before testing a remote system.\n    apiBaseUrl: \"http://127.0.0.1:4100\"\n    webApps: []\naccounts: []\nqa:\n  destructiveActions: forbid\n\`\`\`\n`;
}

export async function generateProject(answers, outputDirectory) {
  validateAnswers(answers);
  const destination = path.resolve(outputDirectory);
  const skills = selectSkills(answers);
  const templateDirectory = path.join(root, "scheme", "project-template");
  const files = ["CLAUDE.md", ".ai/architecture.md", ".ai/capabilities.md", ".ai/state.md", ".ai/decisions.md", ".ai/selected-skills.md"];

  await fs.mkdir(destination, { recursive: true });
  await writeFile(path.join(destination, ".ai/project.yaml"), projectYaml(answers));
  for (const relative of files) {
    const source = await fs.readFile(path.join(templateDirectory, relative), "utf8");
    await writeFile(path.join(destination, relative), template(source, answers, skills));
  }
  if (answers.qa.enabled) {
    await writeFile(path.join(destination, ".qa/qa-system.md"), qaSystem(answers));
    for (const relative of [".qa/critical-flows.md", ".qa/fixtures.md"]) {
      const source = await fs.readFile(path.join(templateDirectory, relative), "utf8");
      await writeFile(path.join(destination, relative), template(source, answers, skills));
    }
  }
  return { destination, profile: answers.project.profile, skills, qaEnabled: answers.qa.enabled };
}

async function readAnswers(file) {
  const source = await fs.readFile(path.resolve(file), "utf8");
  return file.endsWith(".json") ? JSON.parse(source) : parseYaml(source);
}

function usage() {
  return "Usage: node scheme/scripts/bootstrap.mjs --answers <answers.yaml|json> --output <new-project-directory>";
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const answerIndex = args.indexOf("--answers");
  const outputIndex = args.indexOf("--output");
  if (answerIndex < 0 || outputIndex < 0 || !args[answerIndex + 1] || !args[outputIndex + 1]) {
    console.error(usage());
    process.exitCode = 1;
  } else {
    try {
      const result = await generateProject(await readAnswers(args[answerIndex + 1]), args[outputIndex + 1]);
      console.log(`Generated ${result.profile} project at ${result.destination}`);
      console.log(`Selected skills: ${result.skills.join(", ")}`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
