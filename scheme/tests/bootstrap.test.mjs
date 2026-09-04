import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generateProject, selectSkills, validateAnswers } from "../scripts/bootstrap.mjs";

const base = {
  project: { name: "Example", type: "product", profile: "small", expected_lifetime: "short" },
  platforms: { backend: { enabled: true }, web: { enabled: true }, flutter: { enabled: false }, android_native: { enabled: false }, ios_native: { enabled: false } },
  database: { engine: "postgres" },
  environments: ["dev", "qa"],
  qa: { enabled: true, api: true, web: true, mobile: false },
  security: { sensitivity: "low", regulated: false },
};

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "project-scheme-test-"));
try {
  // Scenario A: web-only freelance project stays lightweight.
  const small = structuredClone(base);
  const smallResult = await generateProject(small, path.join(temporary, "small"));
  assert(!smallResult.skills.includes("flutter-mobile"));
  assert(!smallResult.skills.includes("native-android"));
  assert.match(await fs.readFile(path.join(smallResult.destination, ".ai/architecture.md"), "utf8"), /simple_feature_first/);
  assert(await fs.stat(path.join(smallResult.destination, ".qa/qa-system.md")));
  await assert.rejects(fs.stat(path.join(smallResult.destination, "scheme")));

  // Scenario B: production Flutter gets flavor-aware mobile, QA, and release guidance.
  const flutter = structuredClone(base);
  flutter.project = { ...flutter.project, name: "Flutter Product", profile: "production", expected_lifetime: "long" };
  flutter.platforms.web.enabled = false;
  flutter.platforms.flutter.enabled = true;
  flutter.mobile = { flavors: ["dev", "qa", "production"] };
  flutter.qa = { enabled: true, api: true, web: false, mobile: true };
  const flutterResult = await generateProject(flutter, path.join(temporary, "flutter"));
  assert(flutterResult.skills.includes("flutter-mobile"));
  assert(flutterResult.skills.includes("release-readiness"));
  assert(flutterResult.skills.includes("qa-integration"));

  // Scenario C: large multi-platform product selects all relevant controls.
  const enterprise = structuredClone(base);
  enterprise.project = { ...enterprise.project, name: "Platform", profile: "enterprise", expected_lifetime: "long" };
  enterprise.platforms.flutter.enabled = true;
  enterprise.platforms.android_native.enabled = true;
  enterprise.platforms.ios_native.enabled = true;
  enterprise.security = { sensitivity: "high", regulated: true };
  const enterpriseResult = await generateProject(enterprise, path.join(temporary, "enterprise"));
  for (const skill of ["backend-api", "web-application", "flutter-mobile", "native-android", "native-ios", "security-baseline", "release-readiness"]) assert(enterpriseResult.skills.includes(skill));

  assert.throws(() => validateAnswers({}), /project.name/);
  assert.deepEqual(selectSkills({ ...base, qa: { enabled: false }, platforms: { backend: { enabled: false } }, database: {} }).includes("qa-integration"), false);
  console.log("bootstrap tests passed: 3 scenarios, schema guards, selective skills, generated structure");
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
