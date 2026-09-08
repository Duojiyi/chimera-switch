// Minimal vitest-compatible harness for the fork's workflow contract suite.
//
// This suite is fork-owned tooling, so it must not add dependencies to the
// upstream-owned root package.json (scripts/check-upstream-manifest.mjs
// enforces that). It therefore runs on node:test instead of vitest, and this
// module maps the exact matcher surface the suite uses onto
// node:assert/strict with the same semantics vitest gives each matcher.
// Anything not implemented here throws instead of silently passing.

import assert from "node:assert/strict";
import { describe, it as nodeIt } from "node:test";

const show = (value) =>
  typeof value === "string" ? JSON.stringify(value) : String(value);

const formatTitle = (title, args) => {
  let index = 0;
  return title.replace(/%[sdifjo%]/g, (token) => {
    if (token === "%%") return "%";
    if (index >= args.length) return token;
    const value = args[index++];
    if (token === "%j" || token === "%o") return JSON.stringify(value);
    if (token === "%d" || token === "%i" || token === "%f")
      return String(Number(value));
    return typeof value === "string" ? value : JSON.stringify(value);
  });
};

const each = (rows) => (title, fn) => {
  for (const row of rows) {
    const args = Array.isArray(row) ? row : [row];
    nodeIt(formatTitle(title, args), () => fn(...args));
  }
};

export const it = Object.assign((...args) => nodeIt(...args), { each });
export { describe };

// Every matcher is a predicate plus both failure messages, so the negated form
// can never degrade into a no-op.
const matchers = {
  toBe: {
    pass: (actual, expected) => Object.is(actual, expected),
    message: (actual, expected) =>
      `expected ${show(actual)} to be ${show(expected)}`,
  },
  toEqual: {
    pass: (actual, expected) => {
      try {
        assert.deepStrictEqual(actual, expected);
        return true;
      } catch {
        return false;
      }
    },
    message: (actual, expected) =>
      `expected ${JSON.stringify(actual)} to equal ${JSON.stringify(expected)}`,
  },
  toContain: {
    pass: (actual, expected) => {
      if (typeof actual === "string") {
        if (typeof expected !== "string") {
          throw new TypeError("toContain on a string requires a string needle");
        }
        return actual.includes(expected);
      }
      if (actual && typeof actual[Symbol.iterator] === "function") {
        return [...actual].some((item) => Object.is(item, expected));
      }
      throw new TypeError("toContain requires a string or iterable receiver");
    },
    message: (actual, expected) =>
      `expected receiver to contain ${show(expected)}`,
  },
  toMatch: {
    pass: (actual, pattern) => {
      if (typeof actual !== "string") {
        throw new TypeError("toMatch requires a string receiver");
      }
      return pattern instanceof RegExp
        ? pattern.test(actual)
        : actual.includes(pattern);
    },
    message: (actual, pattern) =>
      `expected receiver to match ${String(pattern)}`,
  },
  toBeGreaterThan: {
    pass: (actual, expected) => {
      if (typeof actual !== "number" || typeof expected !== "number") {
        throw new TypeError("toBeGreaterThan requires numbers");
      }
      return actual > expected;
    },
    message: (actual, expected) =>
      `expected ${show(actual)} to be greater than ${show(expected)}`,
  },
  toBeGreaterThanOrEqual: {
    pass: (actual, expected) => {
      if (typeof actual !== "number" || typeof expected !== "number") {
        throw new TypeError("toBeGreaterThanOrEqual requires numbers");
      }
      return actual >= expected;
    },
    message: (actual, expected) =>
      `expected ${show(actual)} to be greater than or equal to ${show(expected)}`,
  },
  toBeUndefined: {
    pass: (actual) => actual === undefined,
    message: (actual) => `expected ${show(actual)} to be undefined`,
  },
};

const explain = (message, hint) =>
  hint === undefined ? message : `${message} [${hint}]`;

// toThrow needs the thrown value, so it cannot be a pure predicate.
const runThrowing = (actual) => {
  if (typeof actual !== "function") {
    throw new TypeError("toThrow requires a function receiver");
  }
  try {
    actual();
    return { threw: false };
  } catch (error) {
    return { threw: true, error };
  }
};

const messageOf = (error) =>
  error instanceof Error ? error.message : String(error);

const buildAssertions = (actual, hint, negated) => {
  const api = {};
  for (const [name, matcher] of Object.entries(matchers)) {
    api[name] = (...args) => {
      const passed = matcher.pass(actual, ...args);
      if (passed === negated) {
        assert.fail(
          explain(
            negated
              ? `not: ${matcher.message(actual, ...args)}`
              : matcher.message(actual, ...args),
            hint,
          ),
        );
      }
    };
  }
  api.toThrow = (expected) => {
    const outcome = runThrowing(actual);
    if (negated) {
      if (outcome.threw) {
        assert.fail(
          explain(`expected no throw, got: ${messageOf(outcome.error)}`, hint),
        );
      }
      return;
    }
    if (!outcome.threw) {
      assert.fail(explain("expected receiver to throw", hint));
    }
    if (expected === undefined) return;
    const message = messageOf(outcome.error);
    const matched =
      expected instanceof RegExp
        ? expected.test(message)
        : message.includes(expected);
    if (!matched) {
      assert.fail(
        explain(
          `expected throw matching ${String(expected)}, got: ${message}`,
          hint,
        ),
      );
    }
  };
  return api;
};

export const expect = (actual, hint) =>
  Object.assign(buildAssertions(actual, hint, false), {
    not: buildAssertions(actual, hint, true),
  });
