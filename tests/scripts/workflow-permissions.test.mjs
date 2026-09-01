import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const readWorkflow = (name) =>
  fs.readFileSync(path.resolve(".github/workflows", name), "utf8");

const expectedR2Permissions = Object.freeze({
  actions: "read",
  contents: "read",
});

const expectedPromotionPermissions = Object.freeze({
  "resolve-release": Object.freeze({ actions: "read", contents: "write" }),
  "promote-stable": Object.freeze({ actions: "read", contents: "write" }),
  "authorize-repair": Object.freeze({ contents: "read" }),
});

const forbiddenResolverCommands = [
  /\bgh\s+api\b[^\n]*(?:--method|-X)\s+(?:POST|PUT|PATCH|DELETE)\b/i,
  /\bgh\s+release\s+(?:create|delete|edit|upload)\b/i,
  /\bgit\s+push\b/i,
];

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

  const approvedWriters = new Set(["resolve-release", "promote-stable"]);
  for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
    if (
      job?.permissions?.contents === "write" &&
      !approvedWriters.has(jobName)
    ) {
      throw new Error(`unexpected contents writer: ${jobName}`);
    }
  }

  const resolver = workflow.jobs?.["resolve-release"];
  if (!Array.isArray(resolver?.steps)) {
    throw new TypeError("resolve-release must define explicit steps");
  }
  if (resolver.environment !== "release") {
    throw new Error(
      "resolve-release must use the protected release environment",
    );
  }

  const checkout = resolver.steps.find(
    (step) =>
      typeof step.uses === "string" &&
      step.uses.startsWith("actions/checkout@"),
  );
  if (checkout?.with?.["persist-credentials"] !== false) {
    throw new Error(
      "resolve-release checkout must not persist write credentials",
    );
  }

  const resolverCommands = resolver.steps
    .map((step) => (typeof step.run === "string" ? step.run : ""))
    .join("\n");
  for (const pattern of forbiddenResolverCommands) {
    if (pattern.test(resolverCommands)) {
      throw new Error("resolve-release must remain non-mutating");
    }
  }
}

function loadProductionWorkflows() {
  return {
    caller: parseWorkflow("promote-release.yml"),
    callee: parseWorkflow("sync-r2.yml"),
  };
}

describe("release promotion permissions", () => {
  it("confines draft visibility and publication write access to approved jobs", () => {
    const { caller } = loadProductionWorkflows();

    expect(() => validatePromotionPermissionContract(caller)).not.toThrow();
  });

  it("rejects read-only draft resolution because GitHub hides draft releases", () => {
    const { caller } = loadProductionWorkflows();
    caller.jobs["resolve-release"].permissions.contents = "read";

    expect(() => validatePromotionPermissionContract(caller)).toThrow(
      "resolve-release job must declare exactly the approved permissions",
    );
  });

  it("rejects unnecessary permissions on the draft resolver", () => {
    const { caller } = loadProductionWorkflows();
    caller.jobs["resolve-release"].permissions.issues = "read";

    expect(() => validatePromotionPermissionContract(caller)).toThrow(
      "resolve-release job must declare exactly the approved permissions",
    );
  });

  it("keeps the R2 repair authorization job read-only", () => {
    const { caller } = loadProductionWorkflows();
    caller.jobs["authorize-repair"].permissions.contents = "write";

    expect(() => validatePromotionPermissionContract(caller)).toThrow(
      "authorize-repair job must declare exactly the approved permissions",
    );
  });

  it("rejects write access on a future unapproved job", () => {
    const { caller } = loadProductionWorkflows();
    caller.jobs["future-job"] = { permissions: { contents: "write" } };

    expect(() => validatePromotionPermissionContract(caller)).toThrow(
      "unexpected contents writer: future-job",
    );
  });

  it("requires environment protection for draft visibility access", () => {
    const { caller } = loadProductionWorkflows();
    delete caller.jobs["resolve-release"].environment;

    expect(() => validatePromotionPermissionContract(caller)).toThrow(
      "resolve-release must use the protected release environment",
    );
  });

  it.each([
    'gh api --method PATCH "repos/example/releases/1" -F draft=false',
    'gh api -X DELETE "repos/example/releases/1"',
    "gh release edit v1.2.3 --draft=false",
    "git push origin main",
  ])("rejects a mutating resolver command: %s", (command) => {
    const { caller } = loadProductionWorkflows();
    caller.jobs["resolve-release"].steps.push({ run: command });

    expect(() => validatePromotionPermissionContract(caller)).toThrow(
      "resolve-release must remain non-mutating",
    );
  });

  it("rejects persisted write credentials in the resolver checkout", () => {
    const { caller } = loadProductionWorkflows();
    const checkout = caller.jobs["resolve-release"].steps.find((step) =>
      step.uses?.startsWith("actions/checkout@"),
    );
    checkout.with["persist-credentials"] = true;

    expect(() => validatePromotionPermissionContract(caller)).toThrow(
      "resolve-release checkout must not persist write credentials",
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

  it("compares permission maps independent of YAML key order", () => {
    const { caller, callee } = loadProductionWorkflows();
    caller.jobs["sync-r2"].permissions = {
      actions: "read",
      contents: "read",
    };
    callee.permissions = { contents: "read", actions: "read" };

    expect(() =>
      validateReusablePermissionContract(caller, callee),
    ).not.toThrow();
  });

  it("rejects a new permission in only the callee", () => {
    const { caller, callee } = loadProductionWorkflows();
    callee.permissions.checks = "read";

    expect(() => validateReusablePermissionContract(caller, callee)).toThrow(
      "exactly the required read permissions",
    );
  });

  it("rejects the same unnecessary read permission in caller and callee", () => {
    const { caller, callee } = loadProductionWorkflows();
    caller.jobs["sync-r2"].permissions.checks = "read";
    callee.permissions.checks = "read";

    expect(() => validateReusablePermissionContract(caller, callee)).toThrow(
      "exactly the required read permissions",
    );
  });

  it("rejects removing a permission from the caller", () => {
    const { caller, callee } = loadProductionWorkflows();
    delete caller.jobs["sync-r2"].permissions.actions;

    expect(() => validateReusablePermissionContract(caller, callee)).toThrow(
      "exactly the required read permissions",
    );
  });

  it("rejects write access even when caller and callee agree", () => {
    const { caller, callee } = loadProductionWorkflows();
    caller.jobs["sync-r2"].permissions.actions = "write";
    callee.permissions.actions = "write";

    expect(() => validateReusablePermissionContract(caller, callee)).toThrow(
      "must remain read-only",
    );
  });
});
