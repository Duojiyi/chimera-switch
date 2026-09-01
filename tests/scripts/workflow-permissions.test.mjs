import fs from "node:fs";
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
});

const approvedWriterJobs = new Set(["stage-draft", "promote-stable"]);

function parseWorkflow(name) {
  const workflow = parse(readWorkflow(name));
  if (!workflow || typeof workflow !== "object" || Array.isArray(workflow)) {
    throw new TypeError(`${name} must contain a YAML mapping`);
  }
  return workflow;
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
  if (
    upload.with?.["if-no-files-found"] !== "error" ||
    upload.with?.["retention-days"] !== 1 ||
    upload.with?.["compression-level"] !== 0
  ) {
    throw new Error(`${name} artifact settings must remain fail-closed`);
  }

  const script = stage.run;
  const normalizedScript = script.replace(/\\\r?\n\s*/g, " ");
  const forbidden = [
    /\b(?:curl|wget|bash|sh|python\d*|perl|ruby|node|deno|npm|npx|pnpm)\b/i,
    /\bgh\s+release\b/i,
    /\bgh\s+api\s+graphql\b/i,
    /\bgh\s+api\b[^\n]*(?:--method|\s-X|--input)\b/i,
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
  const patchMatches = script.match(
    /gh api --method PATCH "repos\/\$REPOSITORY\/releases\/\$RELEASE_ID"/g,
  );
  if (patchMatches?.length !== 1) {
    throw new Error(
      "promote-stable must contain exactly one approved Release PATCH",
    );
  }
  const methodMatches =
    script.match(/\bgh\s+api\b[^\n]*(?:--method|-X)\s+\w+/gi) ?? [];
  if (methodMatches.length !== 1 || !/--method PATCH/i.test(methodMatches[0])) {
    throw new Error(
      "promote-stable contains an unapproved explicit API method",
    );
  }
  if (/\bgh\s+api\s+graphql\b|\b(?:curl|wget)\b|\bgit\s+push\b/i.test(script)) {
    throw new Error("promote-stable contains an unapproved mutation channel");
  }
  const formFlags = script.match(/\s-[fF](?:\s|=)/g) ?? [];
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
    'gh api graphql -f query="mutation { deleteRef(input: {}) }"',
    'curl -X DELETE -H "Authorization: Bearer $GH_TOKEN" https://api.github.com/repos/example/releases/1',
  ])("rejects a staging mutation channel: %s", (command) => {
    const { caller } = loadProductionWorkflows();
    caller.jobs["stage-draft"].steps[0].run += `\n${command}`;
    expect(() => validatePromotionPermissionContract(caller)).toThrow(
      "stage-draft must remain a fixed read-only staging reader",
    );
  });

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
