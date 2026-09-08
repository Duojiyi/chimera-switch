// Guards the harness itself: a hand-written matcher shim is only useful if it
// still fails on wrong values, so every matcher the contract suite relies on is
// checked in both polarities here.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { expect, it as forkIt } from "../harness.mjs";

const rejects = (run) => {
  assert.throws(run, (error) => error instanceof assert.AssertionError);
};

describe("harness matchers", () => {
  it("toBe compares with Object.is in both polarities", () => {
    expect("a").toBe("a");
    expect(Number.NaN).toBe(Number.NaN);
    expect("a").not.toBe("b");
    rejects(() => expect("a").toBe("b"));
    rejects(() => expect("a").not.toBe("a"));
  });

  it("toEqual compares structurally", () => {
    expect({ contents: "read" }).toEqual({ contents: "read" });
    rejects(() => expect({ contents: "read" }).toEqual({ contents: "write" }));
    rejects(() => expect({ contents: "read" }).toEqual({}));
  });

  it("toContain matches substrings and members", () => {
    expect("alpha beta").toContain("beta");
    expect(["alpha", "beta"]).toContain("beta");
    expect(new Set(["alpha"])).toContain("alpha");
    expect("alpha").not.toContain("beta");
    rejects(() => expect("alpha").toContain("beta"));
    rejects(() => expect(["alpha"]).toContain("beta"));
    rejects(() => expect("alpha").not.toContain("alpha"));
    assert.throws(() => expect(7).toContain("7"), TypeError);
    assert.throws(() => expect("alpha").toContain(/a/), TypeError);
  });

  it("toMatch honours regular expressions and substrings", () => {
    expect("gh release view").toMatch(/\bgh\s/);
    expect("local check").not.toMatch(/\b(?:gh|git)\s/);
    rejects(() => expect("local check").toMatch(/\bgh\s/));
    rejects(() => expect("gh release view").not.toMatch(/\bgh\s/));
    assert.throws(() => expect(7).toMatch(/7/), TypeError);
  });

  it("toThrow requires a throw and matches its message", () => {
    const boom = () => {
      throw new Error("unexpected write permission: future-job");
    };
    expect(boom).toThrow();
    expect(boom).toThrow("unexpected write permission");
    expect(boom).toThrow(/write permission: future-job/);
    expect(() => {}).not.toThrow();
    rejects(() => expect(() => {}).toThrow());
    rejects(() => expect(() => {}).toThrow("anything"));
    rejects(() => expect(boom).toThrow("a different message"));
    rejects(() => expect(boom).toThrow(/different/));
    rejects(() => expect(boom).not.toThrow());
    assert.throws(() => expect("not a function").toThrow(), TypeError);
  });

  it("compares ordering strictly and inclusively", () => {
    expect(2).toBeGreaterThan(1);
    expect(2).toBeGreaterThanOrEqual(2);
    rejects(() => expect(1).toBeGreaterThan(1));
    rejects(() => expect(1).toBeGreaterThanOrEqual(2));
    assert.throws(() => expect("2").toBeGreaterThan(1), TypeError);
  });

  it("toBeUndefined distinguishes undefined from empty values", () => {
    expect(undefined).toBeUndefined();
    expect(null).not.toBeUndefined();
    expect("").not.toBeUndefined();
    rejects(() => expect(null).toBeUndefined());
    rejects(() => expect(undefined).not.toBeUndefined());
  });

  it("carries the caller hint into failure messages", () => {
    assert.throws(
      () => expect(1, "state=cancelled").toBe(0),
      /state=cancelled/,
    );
  });

  it("refuses unimplemented matchers instead of passing", () => {
    assert.equal(expect(1).toBeCloseTo, undefined);
    assert.throws(() => expect(1).toBeCloseTo(1), TypeError);
    assert.equal(expect(1).not.toBeTruthy, undefined);
  });
});

describe("harness it.each", () => {
  const seen = [];
  forkIt.each([
    ["alpha", 1],
    ["beta", 2],
  ])("expands row %s", (name, value) => {
    seen.push(`${name}:${value}`);
    expect(typeof value).toBe("number");
  });

  forkIt.each(["solo"])("expands bare row %s", (name) => {
    seen.push(name);
  });

  it("ran every row exactly once", () => {
    assert.deepStrictEqual(seen, ["alpha:1", "beta:2", "solo"]);
  });
});
