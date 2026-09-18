import { describe, expect, it } from "vitest";
import { SuspensionState } from "../index.ts";

describe("SuspensionState (runtime, session-scoped)", () => {
  it("starts fresh: nothing suspended, global off", () => {
    const s = new SuspensionState();
    expect(s.globallySuspended).toBe(false);
    expect(s.anySuspended).toBe(false);
    expect(s.suspendedCategoryList()).toEqual([]);
    expect(s.isSuspended()).toBe(false);
  });

  it("sanitizes category names like config categories (email → EMAIL)", () => {
    const s = new SuspensionState();
    s.setCategory("email", true);
    expect(s.suspendedCategoryList()).toEqual(["EMAIL"]);
    expect(s.isCategorySuspended("EMAIL")).toBe(true);
    expect(s.isCategorySuspended("Email")).toBe(true); // case-insensitive
    expect(s.isSuspended("email")).toBe(true);
  });

  it("setCategory toggles on and off; unsuspending removes the category", () => {
    const s = new SuspensionState();
    s.setCategory("CHINA_PHONE", true);
    expect(s.anySuspended).toBe(true);
    expect(s.isCategorySuspended("china_phone")).toBe(true);
    s.setCategory("CHINA_PHONE", false);
    expect(s.anySuspended).toBe(false);
    expect(s.suspendedCategoryList()).toEqual([]);
  });

  it("toggleCategory returns the new state and flips it", () => {
    const s = new SuspensionState();
    expect(s.toggleCategory("api_key")).toBe(true);
    expect(s.isCategorySuspended("API_KEY")).toBe(true);
    expect(s.toggleCategory("API_KEY")).toBe(false);
    expect(s.isCategorySuspended("API_KEY")).toBe(false);
  });

  it("global suspension overrides per-category checks", () => {
    const s = new SuspensionState();
    s.setCategory("EMAIL", true);
    expect(s.isSuspended("CHINA_PHONE")).toBe(false);
    s.setGlobal(true);
    expect(s.isSuspended()).toBe(true);
    expect(s.isSuspended("CHINA_PHONE")).toBe(true); // global wins
    expect(s.globallySuspended).toBe(true);
  });

  it("global + per-category combination: clearing global keeps category suspensions", () => {
    const s = new SuspensionState();
    s.setCategory("EMAIL", true);
    s.setCategory("MAC", true);
    s.setGlobal(true);
    expect(s.anySuspended).toBe(true);
    // Un-suspend globally (e.g. via the picker) → per-category state survives.
    s.setGlobal(false);
    expect(s.globallySuspended).toBe(false);
    expect(s.isCategorySuspended("EMAIL")).toBe(true);
    expect(s.isCategorySuspended("MAC")).toBe(true);
    // Clear one category → the other remains suspended.
    s.setCategory("EMAIL", false);
    expect(s.suspendedCategoryList()).toEqual(["MAC"]);
    expect(s.isSuspended("EMAIL")).toBe(false);
  });

  it("suspendedCategoryList is sorted and stable", () => {
    const s = new SuspensionState();
    s.setCategory("MAC", true);
    s.setCategory("EMAIL", true);
    s.setCategory("UUID", true);
    expect(s.suspendedCategoryList()).toEqual(["EMAIL", "MAC", "UUID"]);
    // duplicates collapse into one entry
    s.setCategory("email", true);
    expect(s.suspendedCategoryList()).toEqual(["EMAIL", "MAC", "UUID"]);
  });

  it("reset returns to a clean session state (config.enabled semantics)", () => {
    const s = new SuspensionState();
    s.setGlobal(true);
    s.setCategory("EMAIL", true);
    s.reset();
    expect(s.globallySuspended).toBe(false);
    expect(s.anySuspended).toBe(false);
    expect(s.suspendedCategoryList()).toEqual([]);
  });
});
