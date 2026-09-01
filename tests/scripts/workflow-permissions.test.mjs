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

function loadProductionWorkflows() {
  return {
    caller: parseWorkflow("promote-release.yml"),
    callee: parseWorkflow("sync-r2.yml"),
  };
}

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
