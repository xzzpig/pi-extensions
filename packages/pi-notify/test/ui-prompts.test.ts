import { describe, expect, it } from "vitest";

import {
  createUiPromptContexts,
  createUiPromptSpanTracker,
  parseUiPromptEvent,
  parseUiSpanSilentPayload,
} from "../extensions/ui-prompts.js";

describe("parseUiPromptEvent", () => {
  it("parses kind and optional title", () => {
    expect(
      parseUiPromptEvent({
        kind: "custom",
        reason: "ui_prompt",
        type: "ui_prompt_start",
      }),
    ).toEqual({ kind: "custom" });
    expect(
      parseUiPromptEvent({
        kind: "select",
        reason: "ui_prompt",
        title: "Pick one",
        type: "ui_prompt_start",
      }),
    ).toEqual({ kind: "select", title: "Pick one" });
    expect(
      parseUiPromptEvent({
        kind: "input",
        title: "Evidence",
        type: "ui_prompt_end",
      }),
    ).toEqual({ kind: "input", title: "Evidence" });
  });

  it("returns undefined for malformed payloads", () => {
    expect(parseUiPromptEvent(undefined)).toBeUndefined();
    expect(parseUiPromptEvent("nope")).toBeUndefined();
    expect(parseUiPromptEvent({})).toBeUndefined();
    expect(parseUiPromptEvent({ kind: "   " })).toBeUndefined();
    expect(parseUiPromptEvent({ kind: 42 })).toBeUndefined();
  });
});

describe("parseUiSpanSilentPayload", () => {
  it("accepts an empty object and a non-blank string reason", () => {
    expect(parseUiSpanSilentPayload({})).toEqual({});
    expect(parseUiSpanSilentPayload({ reason: "fleet" })).toEqual({
      reason: "fleet",
    });
    expect(parseUiSpanSilentPayload({ reason: "  admin  " })).toEqual({
      reason: "admin",
    });
  });

  it("rejects malformed payloads wholesale", () => {
    expect(parseUiSpanSilentPayload(undefined)).toBeUndefined();
    expect(parseUiSpanSilentPayload("nope")).toBeUndefined();
    expect(parseUiSpanSilentPayload(null)).toBeUndefined();
    expect(parseUiSpanSilentPayload(["fleet"])).toBeUndefined();
    expect(parseUiSpanSilentPayload({ reason: "   " })).toBeUndefined();
    expect(parseUiSpanSilentPayload({ reason: 42 })).toBeUndefined();
  });
});

describe("createUiPromptSpanTracker", () => {
  it("hands out unique monotonic span ids", () => {
    const spans = createUiPromptSpanTracker();
    const first = spans.nextSpanId();
    const second = spans.nextSpanId();
    expect(first).not.toBe(second);
    expect(spans.nextSpanId()).not.toBe(first);
    expect(spans.nextSpanId()).not.toBe(second);
  });
});

describe("createUiPromptContexts", () => {
  it("classifies anonymous spans as input-required with core or default label", () => {
    const contexts = createUiPromptContexts();

    expect(contexts.classify(undefined)).toEqual({
      eventId: "input-required",
      label: "Waiting for input",
    });
    expect(contexts.classify("Pick a branch")).toEqual({
      eventId: "input-required",
      label: "Pick a branch",
    });
  });

  it("classifies spans as permission-required while a request is pending", () => {
    const contexts = createUiPromptContexts();
    contexts.trackPermission("req-1", undefined);
    expect(contexts.classify("Unrelated dialog")).toEqual({
      eventId: "permission-required",
      label: "Permission required",
    });

    contexts.resolvePermission("req-1");
    expect(contexts.classify(undefined)).toEqual({
      eventId: "input-required",
      label: "Waiting for input",
    });
  });

  it("credits the forwarding requester in the permission label", () => {
    const contexts = createUiPromptContexts();
    contexts.trackPermission("req-1", "Worker");
    expect(contexts.classify(undefined)).toEqual({
      eventId: "permission-required",
      label: "Permission required by Worker",
    });
  });

  it("labels spans with the sanitized ask title while a flow is active", () => {
    const contexts = createUiPromptContexts();
    contexts.registerAskFlow("ask-1", "Choose deployment\ntarget");
    expect(contexts.classify(undefined)).toEqual({
      eventId: "input-required",
      label: "Choose deployment target",
    });

    contexts.completeAskFlow("ask-1");
    expect(contexts.classify(undefined)).toEqual({
      eventId: "input-required",
      label: "Waiting for input",
    });
  });

  it("falls back to the default label for an untitled ask flow", () => {
    const contexts = createUiPromptContexts();
    contexts.registerAskFlow("ask-1", undefined);
    expect(contexts.classify(undefined)).toEqual({
      eventId: "input-required",
      label: "Waiting for input",
    });
  });

  it("prefers pending permission over an active ask flow", () => {
    const contexts = createUiPromptContexts();
    contexts.registerAskFlow("ask-1", "Pick one");
    contexts.trackPermission("req-1", undefined);
    expect(contexts.classify(undefined)).toEqual({
      eventId: "permission-required",
      label: "Permission required",
    });
  });

  it("ignores unknown resolutions and clears everything on reset", () => {
    const contexts = createUiPromptContexts();
    contexts.resolvePermission("unknown");
    contexts.completeAskFlow("unknown");

    contexts.registerAskFlow("ask-1", "Pick one");
    contexts.trackPermission("req-1", "Worker");
    contexts.reset();
    expect(contexts.classify(undefined)).toEqual({
      eventId: "input-required",
      label: "Waiting for input",
    });
  });

  it("consumes the pending silent marker once and only once", () => {
    const contexts = createUiPromptContexts();
    expect(contexts.consumeSilent()).toBe(false);

    contexts.markSilent();
    expect(contexts.consumeSilent()).toBe(true);
    expect(contexts.consumeSilent()).toBe(false);
  });

  it("clears the pending silent marker on reset", () => {
    const contexts = createUiPromptContexts();
    contexts.markSilent();
    contexts.reset();
    expect(contexts.consumeSilent()).toBe(false);
  });

  it("keeps classification intact while a silent marker is pending", () => {
    const contexts = createUiPromptContexts();
    contexts.trackPermission("req-1", undefined);
    contexts.markSilent();
    // The marker is consumed by the adapter before classify(); the
    // classification context itself is untouched by it.
    expect(contexts.classify(undefined)).toEqual({
      eventId: "permission-required",
      label: "Permission required",
    });
  });
});
