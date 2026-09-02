import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const readWorkflow = (name) =>
  fs.readFileSync(path.resolve(".github/workflows", name), "utf8");

const uploadArtifactAction =
  "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a";
const checkoutAction =
  "actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803";
const downloadArtifactAction =
  "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c";

const expectedR2Permissions = Object.freeze({
  actions: "read",
  contents: "read",
});

const expectedPromotionPermissions = Object.freeze({
  request: Object.freeze({ contents: "read" }),
  "stage-draft": Object.freeze({ contents: "write" }),
  "stage-stable": Object.freeze({ contents: "read" }),
  "verify-release": Object.freeze({ actions: "read", contents: "read" }),
  "promote-stable": Object.freeze({ contents: "write" }),
  "authorize-repair": Object.freeze({ contents: "read" }),
  "verify-published": Object.freeze({ contents: "read" }),
  "promotion-gate": Object.freeze({ contents: "read" }),
});

const approvedWriterJobs = new Set(["stage-draft", "promote-stable"]);

const expectedPromotionGateStepDigest =
  "019bb38b84606d6c0b79f33b9547aa68a5261e7102b0015423599faa5bb997fa";

const expectedWriterStepDigests = Object.freeze({
  "stage-draft": Object.freeze([
    "3f6ce2d9b6f1757de086f30b500ef8f4da53023bf05ea0728fadc5c3d17863ad",
    "8aa28dc9e5885ffd483c5f90f32ad7b32b9fd61dd8ba32748d2a7b919468a2a1",
  ]),
  "promote-stable": Object.freeze([
    "3f86b3e05261dcf090647505a35ba0995c642a1bb7e4c4d0f372f9a7f0f21f45",
    "2d55e0b4f9274a9dbc788b35a5886754ce2b758242d106bc6b6dfc9f7e2fead2",
    "2268e0796958a4788a4d6b9f2d19a837d2b9903b4f1ba90762860e680f86669b",
  ]),
});

const stageOutputs = Object.freeze({
  release_id: "${{ steps.stage.outputs.release_id }}",
  source_sha: "${{ steps.stage.outputs.source_sha }}",
  verification_tooling_sha:
    "${{ steps.stage.outputs.verification_tooling_sha }}",
  release_phase: "${{ steps.stage.outputs.release_phase }}",
  artifact_name: "${{ steps.stage.outputs.artifact_name }}",
});

const expectedPromotionGraph = Object.freeze({
  request: Object.freeze({
    needs: null,
    if: null,
    outputs: Object.freeze({
      tag: "${{ steps.request.outputs.tag }}",
      request_id: "${{ steps.request.outputs.request_id }}",
      mode: "${{ steps.route.outputs.mode }}",
    }),
  }),
  "stage-draft": Object.freeze({
    needs: "request",
    if: "needs.request.outputs.mode == 'promote'",
    outputs: stageOutputs,
  }),
  "stage-stable": Object.freeze({
    needs: "request",
    if: "needs.request.outputs.mode == 'repair'",
    outputs: stageOutputs,
  }),
  "verify-release": Object.freeze({
    needs: Object.freeze(["request", "stage-draft", "stage-stable"]),
    if: "always() && needs.request.result == 'success' && ((needs.request.outputs.mode == 'promote' && needs.stage-draft.result == 'success') || (needs.request.outputs.mode == 'repair' && needs.stage-stable.result == 'success'))",
    outputs: Object.freeze({
      tag: "${{ steps.verify.outputs.tag }}",
      request_id: "${{ steps.verify.outputs.request_id }}",
      mode: "${{ steps.route.outputs.mode }}",
      release_id: "${{ steps.verify.outputs.release_id }}",
      source_sha: "${{ steps.verify.outputs.source_sha }}",
      release_tooling_sha: "${{ steps.verify.outputs.release_tooling_sha }}",
      verification_tooling_sha:
        "${{ steps.verify.outputs.verification_tooling_sha }}",
      workflow_run_id: "${{ steps.verify.outputs.workflow_run_id }}",
      workflow_run_attempt: "${{ steps.verify.outputs.workflow_run_attempt }}",
      asset_snapshot_sha256:
        "${{ steps.verify.outputs.asset_snapshot_sha256 }}",
      release_phase: "${{ steps.verify.outputs.release_phase }}",
    }),
  }),
  "promote-stable": Object.freeze({
    needs: Object.freeze(["verify-release"]),
    if: "needs.verify-release.outputs.mode == 'promote'",
    outputs: Object.freeze({}),
  }),
  "authorize-repair": Object.freeze({
    needs: Object.freeze(["verify-release"]),
    if: "needs.verify-release.outputs.mode == 'repair'",
    outputs: Object.freeze({}),
  }),
  "verify-published": Object.freeze({
    needs: Object.freeze([
      "verify-release",
      "promote-stable",
      "authorize-repair",
    ]),
    if: "always() && needs.verify-release.result == 'success' && ((needs.verify-release.outputs.mode == 'promote' && needs.promote-stable.result == 'success') || (needs.verify-release.outputs.mode == 'repair' && needs.authorize-repair.result == 'success'))",
    outputs: Object.freeze({}),
  }),
  "sync-r2": Object.freeze({
    needs: Object.freeze([
      "verify-release",
      "promote-stable",
      "authorize-repair",
      "verify-published",
    ]),
    if: "always() && needs.verify-published.result == 'success'",
    outputs: Object.freeze({}),
    with: Object.freeze({
      tag: "${{ needs.verify-release.outputs.tag }}",
      request_id: "${{ needs.verify-release.outputs.request_id }}",
      source_sha: "${{ needs.verify-release.outputs.source_sha }}",
      release_tooling_sha:
        "${{ needs.verify-release.outputs.release_tooling_sha }}",
      verification_tooling_sha:
        "${{ needs.verify-release.outputs.verification_tooling_sha }}",
      require_r2: "${{ needs.verify-release.outputs.mode == 'repair' }}",
    }),
  }),
  "promotion-gate": Object.freeze({
    needs: Object.freeze([
      "request",
      "stage-draft",
      "stage-stable",
      "verify-release",
      "promote-stable",
      "authorize-repair",
      "verify-published",
      "sync-r2",
    ]),
    if: "always()",
    outputs: Object.freeze({}),
  }),
});

function parseWorkflow(name) {
  const workflow = parse(readWorkflow(name));
  if (!workflow || typeof workflow !== "object" || Array.isArray(workflow)) {
    throw new TypeError(`${name} must contain a YAML mapping`);
  }
  return workflow;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}

function hashConfiguration(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

function getBashExecutable() {
  if (process.platform !== "win32") return "bash";
  const candidates = [
    process.env.GIT_BASH,
    path.join(
      process.env.ProgramFiles ?? "C:\\Program Files",
      "Git",
      "bin",
      "bash.exe",
    ),
    path.join(
      process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
      "Git",
      "bin",
      "bash.exe",
    ),
  ].filter(Boolean);
  const executable = candidates.find((candidate) => fs.existsSync(candidate));
  if (!executable) {
    throw new Error("Git Bash is required to execute workflow shell contracts");
  }
  return executable;
}

function toBashPath(file) {
  if (process.platform !== "win32") return file;
  return file
    .replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`)
    .replaceAll("\\", "/");
}

function runBashScript(script, environment = {}) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "chimera-workflow-contract-"),
  );
  const outputPath = path.join(directory, "github-output.txt");
  try {
    const result = spawnSync(getBashExecutable(), ["-c", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        ...environment,
        GITHUB_OUTPUT: toBashPath(outputPath),
      },
    });
    return {
      ...result,
      githubOutput: fs.existsSync(outputPath)
        ? fs.readFileSync(outputPath, "utf8")
        : "",
    };
  } finally {
    fs.rmSync(directory, { force: true, recursive: true });
  }
}

function validatePromotionGateStepDigest(workflow) {
  const gate = workflow.jobs?.["promotion-gate"];
  const actual = hashConfiguration(getSteps(gate, "promotion-gate"));
  if (actual !== expectedPromotionGateStepDigest) {
    throw new Error(
      "promotion-gate step definition must match the reviewed SHA-256 allowlist",
    );
  }
}

function validateWriterStepDigests(workflow) {
  for (const [jobName, expected] of Object.entries(expectedWriterStepDigests)) {
    const actual = getSteps(workflow.jobs?.[jobName], jobName).map(
      hashConfiguration,
    );
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(
        `${jobName} step definitions must match the reviewed SHA-256 allowlist`,
      );
    }
  }
}

function validateTaskGraph(workflow) {
  for (const [jobName, expected] of Object.entries(expectedPromotionGraph)) {
    const job = workflow.jobs?.[jobName];
    if (!job) throw new Error(`missing promotion job: ${jobName}`);
    const actual = {
      needs: job.needs ?? null,
      if: job.if ?? null,
      outputs: job.outputs ?? {},
    };
    if (Object.hasOwn(expected, "with")) actual.with = job.with ?? {};
    if (
      JSON.stringify(canonicalize(actual)) !==
      JSON.stringify(canonicalize(expected))
    ) {
      throw new Error(`${jobName} task graph or output wiring changed`);
    }
  }
}

function normalizePermissions(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must define an explicit permission map`);
  }

  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function expectExactPermissions(actual, expected, label) {
  if (
    JSON.stringify(normalizePermissions(actual, label)) !==
    JSON.stringify(normalizePermissions(expected, `expected ${label}`))
  ) {
    throw new Error(`${label} must declare exactly the approved permissions`);
  }
}

function grantsWrite(value) {
  if (value === "write-all") return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).some((access) => access === "write");
}

function requireEnvironment(job, name) {
  if (job?.environment !== "release") {
    throw new Error(`${name} must use the protected release environment`);
  }
}

function getSteps(job, name) {
  if (!Array.isArray(job?.steps)) {
    throw new TypeError(`${name} must define explicit steps`);
  }
  return job.steps;
}

function getRun(job, stepName) {
  const step = getSteps(job, "job").find(
    (candidate) => candidate.name === stepName,
  );
  if (typeof step?.run !== "string") {
    throw new Error(`${stepName} must be an inline run step`);
  }
  return step.run;
}

function expectExactStepNames(job, expected, name) {
  const actual = getSteps(job, name).map((step) => step.name);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${name} steps must match the approved allowlist`);
  }
}

function validateStagingJob(job, name, expectedFirstStep) {
  requireEnvironment(job, name);
  expectExactStepNames(
    job,
    [expectedFirstStep, "Upload isolated release package"],
    name,
  );

  const [stage, upload] = job.steps;
  if (typeof stage.run !== "string" || stage.uses !== undefined) {
    throw new Error(`${name} must stage bytes with the approved inline reader`);
  }
  if (upload.uses !== uploadArtifactAction || upload.run !== undefined) {
    throw new Error(`${name} may only use the pinned artifact uploader`);
  }
  const expectedUpload = {
    name: "${{ steps.stage.outputs.artifact_name }}",
    path: "promotion-stage",
    "if-no-files-found": "error",
    "retention-days": 1,
    "compression-level": 0,
  };
  if (
    JSON.stringify(canonicalize(upload.with)) !==
    JSON.stringify(canonicalize(expectedUpload))
  ) {
    throw new Error(
      `${name} artifact settings must remain exactly allowlisted`,
    );
  }

  const script = stage.run;
  const normalizedScript = script.replace(/\\\r?\n\s*/g, " ");
  const forbidden = [
    /\b(?:curl|wget|bash|sh|python\d*|perl|ruby|node|deno|npm|npx|pnpm)\b/i,
    /\bgh\s+release\b/i,
    /\bgh\s+api\s+graphql\b/i,
    /\bgh\s+api\b[^\n]*(?:--method(?:\s|=)|\s-X|--input(?:\s|=))/i,
    /\bgh\s+api\b[^\n]*(?:\s-[fF]|--field|--raw-field)(?:\s|=)/i,
    /\bgit\s+(?:push|tag|commit)\b/i,
    /\bscripts\//i,
  ];
  for (const pattern of forbidden) {
    if (pattern.test(normalizedScript)) {
      throw new Error(`${name} must remain a fixed read-only staging reader`);
    }
  }

  const allowedApiFragments = [
    '"repos/$REPOSITORY/compare/$source_sha...$main_sha"',
    '"repos/$REPOSITORY/releases?per_page=100"',
    '"repos/$REPOSITORY/releases/tags/$TAG"',
    '"repos/$REPOSITORY/releases/assets/$asset_id"',
    '"repos/$REPOSITORY/releases/$release_id"',
  ];
  for (const line of normalizedScript
    .split("\n")
    .filter((line) => /\bgh api\b/.test(line))) {
    if (!allowedApiFragments.some((fragment) => line.includes(fragment))) {
      throw new Error(`${name} contains a non-allowlisted GitHub API read`);
    }
  }
}

function validatePublisherJob(job) {
  requireEnvironment(job, "promote-stable");
  expectExactStepNames(
    job,
    [
      "Require immutable releases",
      "Validate optional mirror configuration before publication",
      "Commit verified release state idempotently",
    ],
    "promote-stable",
  );
  if (job.steps.some((step) => step.uses !== undefined)) {
    throw new Error(
      "promote-stable must not execute third-party or repository actions",
    );
  }

  const script = job.steps.map((step) => step.run ?? "").join("\n");
  const normalizedScript = script.replace(/\\\r?\n\s*/g, " ");
  const patchMatches = normalizedScript.match(
    /gh api --method PATCH "repos\/\$REPOSITORY\/releases\/\$RELEASE_ID"/g,
  );
  if (patchMatches?.length !== 1) {
    throw new Error(
      "promote-stable must contain exactly one approved Release PATCH",
    );
  }
  const explicitMethods = [
    ...normalizedScript.matchAll(
      /(?:--method(?:\s+|=)|(?:^|\s)-X(?:\s+|=)?)([A-Za-z]+)/gim,
    ),
  ].map((match) => match[1].toUpperCase());
  if (explicitMethods.length !== 1 || explicitMethods[0] !== "PATCH") {
    throw new Error(
      "promote-stable contains an unapproved explicit API method",
    );
  }
  if (
    /\bgh\s+api\s+graphql\b|\bgh\s+release\b|\b(?:curl|wget)\b|\bgit\s+push\b/i.test(
      normalizedScript,
    )
  ) {
    throw new Error("promote-stable contains an unapproved mutation channel");
  }
  if (/--input(?:\s|=)|--(?:raw-)?field(?:\s|=)/i.test(normalizedScript)) {
    throw new Error("promote-stable contains an unapproved API input channel");
  }
  const formFlags = normalizedScript.match(/\s-[fF](?=\s|=|[A-Za-z_])/g) ?? [];
  if (formFlags.length !== 3) {
    throw new Error(
      "promote-stable form fields must be confined to the Release PATCH",
    );
  }
}

function validateAllCheckouts(workflow) {
  for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
    for (const step of Array.isArray(job?.steps) ? job.steps : []) {
      if (
        typeof step.uses === "string" &&
        step.uses.startsWith("actions/checkout@")
      ) {
        if (step.uses !== checkoutAction) {
          throw new Error(`${jobName} must pin the approved checkout revision`);
        }
        if (step.with?.["persist-credentials"] !== false) {
          throw new Error(`${jobName} checkout must not persist credentials`);
        }
      }
    }
  }
}

function validateReusablePermissionContract(caller, callee) {
  const callJob = caller.jobs?.["sync-r2"];
  if (callJob?.uses !== "./.github/workflows/sync-r2.yml") {
    throw new Error("sync-r2 must call the local reusable workflow");
  }

  const callerPermissions = normalizePermissions(
    callJob.permissions,
    "sync-r2 caller",
  );
  const calleePermissions = normalizePermissions(
    callee.permissions,
    "sync-r2 callee",
  );
  for (const [permission, access] of Object.entries(calleePermissions)) {
    if (access !== "read") {
      throw new Error(
        `sync-r2 reusable permissions must remain read-only: ${permission}=${access}`,
      );
    }
  }

  const expectedPermissions = normalizePermissions(
    expectedR2Permissions,
    "expected sync-r2 permissions",
  );
  if (
    JSON.stringify(callerPermissions) !== JSON.stringify(expectedPermissions) ||
    JSON.stringify(calleePermissions) !== JSON.stringify(expectedPermissions)
  ) {
    throw new Error(
      "sync-r2 caller and callee must declare exactly the required read permissions",
    );
  }
}

function validatePromotionPermissionContract(workflow) {
  expectExactPermissions(
    workflow.permissions,
    { contents: "read" },
    "promote-release workflow",
  );
  for (const [jobName, expected] of Object.entries(
    expectedPromotionPermissions,
  )) {
    expectExactPermissions(
      workflow.jobs?.[jobName]?.permissions,
      expected,
      `${jobName} job`,
    );
  }
  for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
    if (grantsWrite(job?.permissions) && !approvedWriterJobs.has(jobName)) {
      throw new Error(`unexpected write permission: ${jobName}`);
    }
  }

  validateTaskGraph(workflow);

  const draft = workflow.jobs?.["stage-draft"];
  const stable = workflow.jobs?.["stage-stable"];
  const publisher = workflow.jobs?.["promote-stable"];
  if (draft?.if !== "needs.request.outputs.mode == 'promote'") {
    throw new Error("stage-draft must only run in promote mode");
  }
  if (stable?.if !== "needs.request.outputs.mode == 'repair'") {
    throw new Error("stage-stable must only run in repair mode");
  }
  if (publisher?.if !== "needs.verify-release.outputs.mode == 'promote'") {
    throw new Error("promote-stable must only run in promote mode");
  }

  validateStagingJob(
    draft,
    "stage-draft",
    "Stage draft or previously published release",
  );
  validateStagingJob(stable, "stage-stable", "Stage immutable stable release");
  validatePublisherJob(publisher);
  validateWriterStepDigests(workflow);
  validatePromotionGateStepDigest(workflow);
  validateAllCheckouts(workflow);

  if (
    workflow.jobs?.["verify-release"]?.steps?.[1]?.uses !==
    downloadArtifactAction
  ) {
    throw new Error("verify-release must consume the pinned isolated artifact");
  }
}

function loadProductionWorkflows() {
  return {
    caller: parseWorkflow("promote-release.yml"),
    callee: parseWorkflow("sync-r2.yml"),
    upstream: parseWorkflow("sync-upstream.yml"),
  };
}

describe("release promotion permissions", () => {
  it("confines draft visibility and publication to two isolated write jobs", () => {
    const { caller } = loadProductionWorkflows();
    expect(() => validatePromotionPermissionContract(caller)).not.toThrow();
  });

  it("keeps the complete repair path read-only", () => {
    const { caller } = loadProductionWorkflows();
    for (const jobName of [
      "request",
      "stage-stable",
      "verify-release",
      "authorize-repair",
      "verify-published",
      "sync-r2",
      "promotion-gate",
    ]) {
      expect(grantsWrite(caller.jobs[jobName].permissions)).toBe(false);
    }
    expect(caller.jobs["stage-stable"].if).toBe(
      "needs.request.outputs.mode == 'repair'",
    );
  });

  it("rejects permission shorthand that grants broad write access", () => {
    const { caller } = loadProductionWorkflows();
    caller.jobs["future-job"] = { permissions: "write-all" };
    expect(() => validatePromotionPermissionContract(caller)).toThrow(
      "unexpected write permission: future-job",
    );
  });

  it("rejects write access on a future permission map", () => {
    const { caller } = loadProductionWorkflows();
    caller.jobs["future-job"] = { permissions: { issues: "write" } };
    expect(() => validatePromotionPermissionContract(caller)).toThrow(
      "unexpected write permission: future-job",
    );
  });

  it.each([
    'gh api "repos/example/releases" -f tag_name=v1.2.3',
    'gh api --method=POST "repos/example/releases"',
    'gh api -XDELETE "repos/example/releases/1"',
    'gh api graphql -f query="mutation { deleteRef(input: {}) }"',
    'curl -X DELETE -H "Authorization: Bearer $GH_TOKEN" https://api.github.com/repos/example/releases/1',
  ])("rejects a staging mutation channel: %s", (command) => {
    const { caller } = loadProductionWorkflows();
    caller.jobs["stage-draft"].steps[0].run += `\n${command}`;
    expect(() => validatePromotionPermissionContract(caller)).toThrow(
      "stage-draft must remain a fixed read-only staging reader",
    );
  });

  it.each([
    [
      'gh api --method=DELETE "repos/$REPOSITORY/releases/$RELEASE_ID"',
      "unapproved explicit API method",
    ],
    [
      'gh api -XDELETE "repos/$REPOSITORY/releases/$RELEASE_ID"',
      "unapproved explicit API method",
    ],
    ['gh release delete "$TAG" --yes', "unapproved mutation channel"],
    ['gh release edit "$TAG" --draft=false', "unapproved mutation channel"],
    ['gh release upload "$TAG" unexpected.bin', "unapproved mutation channel"],
  ])("rejects a publisher mutation channel: %s", (command, message) => {
    const { caller } = loadProductionWorkflows();
    caller.jobs["promote-stable"].steps[2].run += `\n${command}`;
    expect(() => validatePromotionPermissionContract(caller)).toThrow(message);
  });

  it.each([
    ["name", "unexpected-artifact"],
    ["path", "."],
  ])("rejects changing the isolated uploader %s", (key, value) => {
    const { caller } = loadProductionWorkflows();
    caller.jobs["stage-draft"].steps[1].with[key] = value;
    expect(() => validatePromotionPermissionContract(caller)).toThrow(
      "stage-draft artifact settings must remain exactly allowlisted",
    );
  });

  it.each([
    ["verify-release", "tag", "${{ needs.request.outputs.tag }}"],
    ["verify-release", "mode", "${{ needs.request.outputs.mode }}"],
    ["verify-release", "release_id", "${{ steps.verify.outputs.source_sha }}"],
    [
      "verify-release",
      "workflow_run_attempt",
      "${{ steps.verify.outputs.workflow_run_id }}",
    ],
    ["stage-draft", "artifact_name", "${{ steps.stage.outputs.release_id }}"],
  ])("rejects changing %s output %s", (jobName, outputName, value) => {
    const { caller } = loadProductionWorkflows();
    caller.jobs[jobName].outputs[outputName] = value;
    expect(() => validatePromotionPermissionContract(caller)).toThrow(
      `${jobName} task graph or output wiring changed`,
    );
  });

  it.each(["verify-release", "verify-published"])(
    "rejects removing always() from %s",
    (jobName) => {
      const { caller } = loadProductionWorkflows();
      caller.jobs[jobName].if = caller.jobs[jobName].if.replace(
        "always() && ",
        "",
      );
      expect(() => validatePromotionPermissionContract(caller)).toThrow(
        `${jobName} task graph or output wiring changed`,
      );
    },
  );

  it("rejects an extra checkout even when its credentials setting looks safe", () => {
    const { caller } = loadProductionWorkflows();
    caller.jobs["stage-draft"].steps.push({
      name: "Extra checkout",
      uses: checkoutAction,
      with: { "persist-credentials": false },
    });
    expect(() => validatePromotionPermissionContract(caller)).toThrow(
      "stage-draft steps must match the approved allowlist",
    );
  });

  it("rejects replacing the isolated uploader with another action", () => {
    const { caller } = loadProductionWorkflows();
    caller.jobs["stage-draft"].steps[1].uses = "example/action@deadbeef";
    expect(() => validatePromotionPermissionContract(caller)).toThrow(
      "stage-draft may only use the pinned artifact uploader",
    );
  });

  it("requires every checkout to be pinned and credential-free", () => {
    const { caller } = loadProductionWorkflows();
    caller.jobs["verify-published"].steps[0].with["persist-credentials"] = true;
    expect(() => validatePromotionPermissionContract(caller)).toThrow(
      "verify-published checkout must not persist credentials",
    );
  });
});

describe("release promotion routing", () => {
  const requestEnvironment = Object.freeze({
    GITHUB_EVENT_ACTION: "",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: "refs/heads/main",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_RUN_ID: "12345",
    INPUT_REQUEST_ID: "audit-request-1234",
    TAG: "v3.20.1",
  });

  const promoteGateEnvironment = Object.freeze({
    AUTHORIZE_REPAIR_RESULT: "skipped",
    PROMOTE_STABLE_RESULT: "success",
    REQUEST_MODE: "promote",
    REQUEST_RESULT: "success",
    STAGE_DRAFT_RESULT: "success",
    STAGE_STABLE_RESULT: "skipped",
    SYNC_R2_RESULT: "success",
    VERIFIED_MODE: "promote",
    VERIFY_PUBLISHED_RESULT: "success",
    VERIFY_RELEASE_RESULT: "success",
  });

  const repairGateEnvironment = Object.freeze({
    AUTHORIZE_REPAIR_RESULT: "success",
    PROMOTE_STABLE_RESULT: "skipped",
    REQUEST_MODE: "repair",
    REQUEST_RESULT: "success",
    STAGE_DRAFT_RESULT: "skipped",
    STAGE_STABLE_RESULT: "success",
    SYNC_R2_RESULT: "success",
    VERIFIED_MODE: "repair",
    VERIFY_PUBLISHED_RESULT: "success",
    VERIFY_RELEASE_RESULT: "success",
  });

  it("isolates mode from user-controlled scalar outputs", () => {
    const { caller } = loadProductionWorkflows();
    const request = caller.jobs.request;
    const requestStep = request.steps.find(
      (step) => step.name === "Validate request and correlation id",
    );
    const routeStep = request.steps.find(
      (step) => step.name === "Resolve requested operation",
    );
    expect(request.outputs.mode).toBe("${{ steps.route.outputs.mode }}");
    expect(requestStep.id).toBe("request");
    expect(routeStep.id).toBe("route");
    expect(requestStep.env.RAW_REPAIR_R2).toBeUndefined();
    expect(routeStep.env.RAW_REPAIR_R2).toBe(
      "${{ inputs.repair_r2 || github.event.client_payload.repair_r2 || false }}",
    );
    expect(requestStep.run).toContain("reject_line_breaks request_id");
    expect(requestStep.run).toContain("printf 'tag=%s\\nrequest_id=%s\\n'");
    expect(routeStep.run).toContain("printf 'mode=%s\\n'");
  });

  it("rejects multiline output injection before writing request outputs", () => {
    const { caller } = loadProductionWorkflows();
    const script = getRun(
      caller.jobs.request,
      "Validate request and correlation id",
    );
    const valid = runBashScript(script, requestEnvironment);
    expect(valid.error).toBeUndefined();
    expect(valid.status).toBe(0);
    expect(valid.githubOutput).toBe(
      "tag=v3.20.1\nrequest_id=audit-request-1234\n",
    );

    const attacks = [
      {
        INPUT_REQUEST_ID: "audit-request-1234\nmode=promote",
      },
      {
        INPUT_REQUEST_ID: "audit-request-1234\rmode=promote",
      },
      {
        TAG: "v3.20.1\nrequest_id=forged-request",
      },
    ];
    for (const attack of attacks) {
      const result = runBashScript(script, {
        ...requestEnvironment,
        ...attack,
      });
      expect(result.status, JSON.stringify(attack)).not.toBe(0);
      expect(result.githubOutput, JSON.stringify(attack)).toBe("");
    }
  });

  it("exports verified routing fields from separate successful steps", () => {
    const { caller } = loadProductionWorkflows();
    const verification = caller.jobs["verify-release"];
    const verifyStep = verification.steps.find(
      (step) =>
        step.name === "Verify signed provenance without write credentials",
    );
    const routeStep = verification.steps.find(
      (step) => step.name === "Export verified operation",
    );
    expect(verification.outputs.tag).toBe("${{ steps.verify.outputs.tag }}");
    expect(verification.outputs.request_id).toBe(
      "${{ steps.verify.outputs.request_id }}",
    );
    expect(verification.outputs.mode).toBe("${{ steps.route.outputs.mode }}");
    expect(verifyStep.env.REQUEST_ID).toBe(
      "${{ needs.request.outputs.request_id }}",
    );
    expect(verifyStep.run).toContain("tag=%s\\nrequest_id=%s\\nrelease_id=%s");
    expect(verifyStep.run).toContain('"$TAG" "$REQUEST_ID" "$RELEASE_ID"');
    expect(verifyStep.run).toContain("reject_line_breaks request_id");
    expect(routeStep.id).toBe("route");
    expect(routeStep.run).toContain("promote|repair");
    expect(routeStep.run).toContain("printf 'mode=%s\\n'");
  });

  it("pins the complete terminal gate and rejects a short circuit", () => {
    const { caller } = loadProductionWorkflows();
    caller.jobs["promotion-gate"].steps[0].run =
      `exit 0\n${caller.jobs["promotion-gate"].steps[0].run}`;
    expect(() => validatePromotionPermissionContract(caller)).toThrow(
      "promotion-gate step definition must match the reviewed SHA-256 allowlist",
    );
  });

  it.each([
    ["promote", promoteGateEnvironment],
    ["repair", repairGateEnvironment],
  ])("accepts the complete %s lifecycle", (_mode, environment) => {
    const { caller } = loadProductionWorkflows();
    const script = getRun(
      caller.jobs["promotion-gate"],
      "Validate complete promotion graph",
    );
    const result = runBashScript(script, environment);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
  });

  it.each([
    ["promote", promoteGateEnvironment],
    ["repair", repairGateEnvironment],
  ])(
    "rejects every unexpected success/skipped/failure/cancelled state in %s mode",
    (_mode, environment) => {
      const { caller } = loadProductionWorkflows();
      const script = getRun(
        caller.jobs["promotion-gate"],
        "Validate complete promotion graph",
      );
      const resultStates = ["success", "skipped", "failure", "cancelled"];
      for (const [name, expected] of Object.entries(environment).filter(
        ([name]) => name.endsWith("_RESULT"),
      )) {
        for (const state of resultStates.filter(
          (state) => state !== expected,
        )) {
          const result = runBashScript(script, {
            ...environment,
            [name]: state,
          });
          expect(result.status, `${name}=${state}`).not.toBe(0);
        }
      }
    },
  );

  it("rejects missing, invalid, or mismatched verified modes", () => {
    const { caller } = loadProductionWorkflows();
    const script = getRun(
      caller.jobs["promotion-gate"],
      "Validate complete promotion graph",
    );
    for (const override of [
      { REQUEST_MODE: "" },
      { REQUEST_MODE: "invalid" },
      { VERIFIED_MODE: "" },
      { VERIFIED_MODE: "repair" },
    ]) {
      const result = runBashScript(script, {
        ...promoteGateEnvironment,
        ...override,
      });
      expect(result.status, JSON.stringify(override)).not.toBe(0);
    }
  });
});

describe("release promotion state machine", () => {
  it("accepts the exact immutable release on a retry", () => {
    const { caller } = loadProductionWorkflows();
    const staging = getRun(
      caller.jobs["stage-draft"],
      "Stage draft or previously published release",
    );
    const publishing = getRun(
      caller.jobs["promote-stable"],
      "Commit verified release state idempotently",
    );
    expect(staging).toContain("release_phase=published");
    expect(staging).toContain(".immutable == true");
    expect(publishing).toContain("release_phase=published");
    expect(publishing).toContain("continuing the idempotent retry");
  });

  it("rechecks protected main immediately before the only Release PATCH", () => {
    const { caller } = loadProductionWorkflows();
    const publishing = getRun(
      caller.jobs["promote-stable"],
      "Commit verified release state idempotently",
    );
    const mainCheck = publishing.lastIndexOf("refs/heads/main");
    const patch = publishing.indexOf("gh api --method PATCH");
    expect(mainCheck).toBeGreaterThanOrEqual(0);
    expect(patch).toBeGreaterThan(mainCheck);
    expect(publishing.slice(mainCheck, patch)).toContain(
      '"$main_sha" = "$VERIFICATION_TOOLING_SHA"',
    );
  });

  it("enforces the fixed 29-file contract and byte limits before staging downloads", () => {
    const { caller } = loadProductionWorkflows();
    const suffixes = [
      "Linux-arm64.AppImage",
      "Linux-arm64.deb",
      "Linux-arm64.rpm",
      "Linux-x86_64.AppImage",
      "Linux-x86_64.deb",
      "Linux-x86_64.rpm",
      "macOS.dmg",
      "macOS.tar.gz",
      "macOS.zip",
      "Windows-arm64-Portable.zip",
      "Windows-arm64.msi",
      "Windows-Portable.zip",
      "Windows.msi",
    ];
    for (const [jobName, stepName] of [
      ["stage-draft", "Stage draft or previously published release"],
      ["stage-stable", "Stage immutable stable release"],
    ]) {
      const staging = getRun(caller.jobs[jobName], stepName);
      const contract = staging.indexOf("expected_assets=()");
      const download = staging.indexOf(
        "while IFS=$'\\t' read -r asset_id name",
      );
      expect(contract).toBeGreaterThanOrEqual(0);
      expect(download).toBeGreaterThan(contract);
      for (const suffix of suffixes) expect(staging).toContain(suffix);
      expect(staging).toContain(
        "expected_assets+=(latest.json provenance.json provenance.json.sig)",
      );
      expect(staging).toContain("fixed 29-file publication contract");
      expect(staging).toContain(".size <= 268435456");
      expect(staging).toContain("add <= 1073741824");
    }
  });

  it("binds provenance and CI verification to the signed run attempt", () => {
    const { caller, callee, upstream } = loadProductionWorkflows();
    const promotionVerify = getRun(
      caller.jobs["verify-release"],
      "Verify signed provenance without write credentials",
    );
    const r2Verify = getRun(
      callee.jobs["sync-to-r2"],
      "Download exact stable assets and verify historical provenance",
    );
    const upstreamPublish = getRun(
      upstream.jobs.publish,
      "Push candidate and create protected sync PR",
    );
    expect(promotionVerify).toContain(
      'run_info=$(gh api "repos/$REPOSITORY/actions/runs/$workflow_run_id/attempts/$workflow_run_attempt")',
    );
    expect(r2Verify).toContain(
      'run_info=$(gh api "repos/$GITHUB_REPOSITORY/actions/runs/$workflow_run_id/attempts/$workflow_run_attempt")',
    );
    expect(upstreamPublish).toContain(
      'final_ci_run=$(gh api "repos/$REPOSITORY/actions/runs/$ci_run_id/attempts/$ci_run_attempt")',
    );
  });

  it("keeps the final Release GET immediately before local checks and the sole PATCH", () => {
    const { caller } = loadProductionWorkflows();
    const publishing = getRun(
      caller.jobs["promote-stable"],
      "Commit verified release state idempotently",
    );
    const mainCheck = publishing.lastIndexOf("refs/heads/main");
    const tagCheck = publishing.lastIndexOf('"refs/tags/$TAG^{}"');
    const releaseGet = publishing.indexOf(
      'release=$(gh api "repos/$REPOSITORY/releases/$RELEASE_ID")',
    );
    const patch = publishing.indexOf("gh api --method PATCH");
    expect(mainCheck).toBeGreaterThanOrEqual(0);
    expect(tagCheck).toBeGreaterThan(mainCheck);
    expect(releaseGet).toBeGreaterThan(tagCheck);
    expect(patch).toBeGreaterThan(releaseGet);
    const afterGetLine = publishing.indexOf("\n", releaseGet);
    expect(publishing.slice(afterGetLine, patch)).not.toMatch(/\b(?:gh|git)\s/);
  });

  it("rechecks protected main and the immutable tag after publication", () => {
    const { caller } = loadProductionWorkflows();
    const verification = getRun(
      caller.jobs["verify-published"],
      "Re-download and verify immutable public release",
    );
    const mainCheck = verification.indexOf("refs/heads/main");
    const tagCheck = verification.indexOf('"refs/tags/$TAG^{}"');
    expect(mainCheck).toBeGreaterThanOrEqual(0);
    expect(tagCheck).toBeGreaterThan(mainCheck);
    expect(verification).toContain(
      '[ "$main_sha" = "$VERIFICATION_TOOLING_SHA" ]',
    );
    expect(verification).toContain('[ "$remote_sha" = "$SOURCE_SHA" ]');
  });

  it("moves fallible attestation checks after the retryable commit point", () => {
    const { caller } = loadProductionWorkflows();
    const publisher = caller.jobs["promote-stable"];
    const postVerify = caller.jobs["verify-published"];
    expect(
      publisher.steps.some((step) => /verify-asset/.test(step.run ?? "")),
    ).toBe(false);
    expect(postVerify.permissions).toEqual({ contents: "read" });
    expect(
      getRun(postVerify, "Re-download and verify immutable public release"),
    ).toContain("gh release verify-asset");
    expect(caller.jobs["sync-r2"].if).toContain(
      "needs.verify-published.result == 'success'",
    );
  });

  it("publishes without R2 at 0/3 and fails closed at partial configuration", () => {
    const { caller } = loadProductionWorkflows();
    const mirror = getRun(
      caller.jobs["promote-stable"],
      "Validate optional mirror configuration before publication",
    );
    expect(mirror).toContain("0)");
    expect(mirror).toContain("mirror synchronization will be skipped");
    expect(mirror).toContain("3)");
    expect(mirror).toContain("partially configured");
    expect(caller.jobs["promote-stable"].steps[0].if).toBe(
      "needs.verify-release.outputs.release_phase == 'draft'",
    );
    expect(caller.jobs["promote-stable"].steps[1].if).toBe(
      "needs.verify-release.outputs.release_phase == 'draft'",
    );
    expect(caller.jobs["sync-r2"].with.require_r2).toBe(
      "${{ needs.verify-release.outputs.mode == 'repair' }}",
    );
  });
});

describe("reusable release workflow permissions", () => {
  it("grants exactly the required read permissions to caller and callee", () => {
    const { caller, callee } = loadProductionWorkflows();
    expect(() =>
      validateReusablePermissionContract(caller, callee),
    ).not.toThrow();
  });

  it("rejects unnecessary or write permissions", () => {
    const { caller, callee } = loadProductionWorkflows();
    caller.jobs["sync-r2"].permissions.actions = "write";
    callee.permissions.actions = "write";
    expect(() => validateReusablePermissionContract(caller, callee)).toThrow(
      "must remain read-only",
    );
  });
});
