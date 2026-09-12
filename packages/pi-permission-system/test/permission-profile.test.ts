import { afterEach, describe, expect, it } from "vitest";
import {
  PERMISSION_PROFILE_ENV,
  PERMISSION_PROFILE_PINNED_ENV,
  isPermissionProfilePinned,
  MAX_PERMISSION_PROFILE_NAME_LENGTH,
  readPermissionProfileEnv,
  validatePermissionProfileName,
} from "#src/permission-profile";

describe("validatePermissionProfileName", () => {
  it("accepts safe bare identifiers", () => {
    for (const name of ["reviewer", "yolo-dev", "a1_B-2", "x"]) {
      expect(validatePermissionProfileName(name)).toBe(name);
    }
  });

  it("rejects empty, non-string, and whitespace-padded values", () => {
    for (const bad of ["", "   ", " spaced", "trail ", 42, null, {}, []]) {
      expect(() => validatePermissionProfileName(bad)).toThrow(
        /non-empty profile name without surrounding whitespace/,
      );
    }
  });

  it("rejects the literal false", () => {
    expect(() => validatePermissionProfileName("false")).toThrow(
      /the literal false is not supported/,
    );
  });

  it("rejects path-like and punctuation names", () => {
    for (const bad of ["../escape", "a/b", "a.b", "$pecial", "a b", "-lead"]) {
      expect(() => validatePermissionProfileName(bad)).toThrow(
        /letters, digits, underscores, or hyphens/,
      );
    }
  });

  it("rejects names over the length limit", () => {
    expect(() =>
      validatePermissionProfileName("a".repeat(MAX_PERMISSION_PROFILE_NAME_LENGTH + 1)),
    ).toThrow(/at most 128 characters/);
    expect(
      validatePermissionProfileName("a".repeat(MAX_PERMISSION_PROFILE_NAME_LENGTH)),
    ).toBe("a".repeat(MAX_PERMISSION_PROFILE_NAME_LENGTH));
  });

  it("uses the caller-provided label in error messages", () => {
    expect(() =>
      validatePermissionProfileName("bad/name", "agent 'x' permission profile"),
    ).toThrow(/agent 'x' permission profile must contain only letters/);
  });
});

describe("readPermissionProfileEnv", () => {
  const original = process.env[PERMISSION_PROFILE_ENV];

  afterEach(() => {
    if (original === undefined) {
      delete process.env[PERMISSION_PROFILE_ENV];
    } else {
      process.env[PERMISSION_PROFILE_ENV] = original;
    }
  });

  it("returns undefined when the variable is unset", () => {
    delete process.env[PERMISSION_PROFILE_ENV];
    expect(readPermissionProfileEnv()).toBeUndefined();
  });

  it("returns undefined for an empty or blank value", () => {
    for (const value of ["", "   "]) {
      process.env[PERMISSION_PROFILE_ENV] = value;
      expect(readPermissionProfileEnv()).toBeUndefined();
    }
  });

  it("returns the trimmed value when set", () => {
    process.env[PERMISSION_PROFILE_ENV] = "  reviewer-strict  ";
    expect(readPermissionProfileEnv()).toBe("reviewer-strict");
  });
});

describe("isPermissionProfilePinned", () => {
  it("is true only for the launcher marker value", () => {
    expect(isPermissionProfilePinned({ [PERMISSION_PROFILE_PINNED_ENV]: "1" })).toBe(true);
    for (const value of ["0", "", "true", "yes", "1 "]) {
      expect(isPermissionProfilePinned({ [PERMISSION_PROFILE_PINNED_ENV]: value })).toBe(false);
    }
    expect(isPermissionProfilePinned({})).toBe(false);
  });

  it("ignores a pinned profile name without the marker", () => {
    expect(isPermissionProfilePinned({ [PERMISSION_PROFILE_ENV]: "reviewer" })).toBe(false);
  });
});
