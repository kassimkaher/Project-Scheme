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
  assert(!smallResult.skills.includes("android-native"));
  assert.match(await fs.readFile(path.join(smallResult.destination, ".ai/architecture.md"), "utf8"), /simple_feature_first/);
  assert(await fs.stat(path.join(smallResult.destination, ".qa/qa-system.md")));
  assert.match(await fs.readFile(path.join(smallResult.destination, ".ai/project.yaml"), "utf8"), /control_plane_version: 2/);
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
  enterprise.payments = { enabled: true };
  const enterpriseResult = await generateProject(enterprise, path.join(temporary, "enterprise"));
  for (const skill of ["backend-api", "web-application", "flutter-mobile", "android-native", "ios-native", "security-baseline", "release-readiness"]) assert(enterpriseResult.skills.includes(skill));
  assert.match(await fs.readFile(path.join(enterpriseResult.destination, ".ai/project.yaml"), "utf8"), /payments:/);

  await fs.writeFile(path.join(smallResult.destination, ".ai/decisions.md"), "# Keep this decision\n");
  await generateProject(small, smallResult.destination);
  assert.equal(await fs.readFile(path.join(smallResult.destination, ".ai/decisions.md"), "utf8"), "# Keep this decision\n");

  // Scenarios D/E: native-only projects select their own platform guidance.
  const android = structuredClone(base);
  android.platforms = { backend: { enabled: false }, web: { enabled: false }, flutter: { enabled: false }, android_native: { enabled: true }, ios_native: { enabled: false } };
  assert((await generateProject(android, path.join(temporary, "android"))).skills.includes("android-native"));
  const ios = structuredClone(android);
  ios.platforms.android_native.enabled = false;
  ios.platforms.ios_native.enabled = true;
  assert((await generateProject(ios, path.join(temporary, "ios"))).skills.includes("ios-native"));

  await assert.rejects(() => validateAnswers({}), /project.name is required/);
  assert.deepEqual(selectSkills({ ...base, qa: { enabled: false }, platforms: { backend: { enabled: false } }, database: {} }).includes("qa-integration"), false);
  console.log("bootstrap tests passed: 5 scenarios, schema guards, selective skills, idempotence, generated structure");
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
