import { describe, expect, it } from "vitest";

import { expandConfigStrings, expandStringValue } from "../extensions/env.js";

const ENV = {
  PI_NOTIFY_TOPIC: "my-topic",
  PI_NOTIFY_TOKEN: "s3cret",
  PI_NOTIFY_URL: "https://ntfy.example.com",
  EMPTY: "",
};

describe("dotenv-expand 13 string expansion", () => {
  it("expands $VAR, ${VAR} and ${VAR:-default}", () => {
    expect(expandStringValue("$PI_NOTIFY_TOPIC", ENV)).toBe("my-topic");
    expect(expandStringValue("${PI_NOTIFY_TOPIC}", ENV)).toBe("my-topic");
    expect(expandStringValue("${PI_NOTIFY_URL}/sub", ENV)).toBe(
      "https://ntfy.example.com/sub",
    );
    expect(expandStringValue("${MISSING:-fallback}", ENV)).toBe("fallback");
    expect(expandStringValue("${EMPTY:-fallback}", ENV)).toBe("fallback");
  });

  it("expands recursively through environment values", () => {
    expect(expandStringValue("$A", { A: "prefix-$B", B: "suffix" })).toBe(
      "prefix-suffix",
    );
  });

  it("expands missing variables to an empty string", () => {
    expect(expandStringValue("x$NOT_SET", ENV)).toBe("x");
    expect(expandStringValue("${NOT_SET}", ENV)).toBe("");
  });

  it("keeps escaped dollar signs literal", () => {
    expect(expandStringValue("\\$PI_NOTIFY_TOPIC", ENV)).toBe(
      "$PI_NOTIFY_TOPIC",
    );
  });

  it("never executes $(...) command substitution", () => {
    const value = "cat $(echo hacked) $((1+1))";
    expect(expandStringValue(value, ENV)).toBe(value);
  });

  it("does not mutate the provided environment object", () => {
    const before = { ...ENV };
    expandStringValue("$PI_NOTIFY_TOPIC", ENV);
    expect(ENV).toEqual(before);
  });
});

describe("config tree expansion", () => {
  it("expands string leaves deep inside the config", () => {
    const expanded = expandConfigStrings(
      {
        ntfy: {
          serverUrl: "$PI_NOTIFY_URL",
          topic: "${PI_NOTIFY_TOPIC}",
          token: "${PI_NOTIFY_TOKEN:-none}",
        },
        enabled: true,
        count: 3,
        list: ["a-$MISSING", null],
      },
      ENV,
    );
    expect(expanded).toEqual({
      ntfy: {
        serverUrl: "https://ntfy.example.com",
        topic: "my-topic",
        token: "s3cret",
      },
      enabled: true,
      count: 3,
      list: ["a-", null],
    });
  });

  it("skips dangerous object keys", () => {
    const expanded = expandConfigStrings(
      { value: "$PI_NOTIFY_TOPIC", __proto__: "polluted", constructor: "x" },
      ENV,
    );
    expect(Object.keys(expanded as object).sort()).toEqual(["value"]);
    expect((expanded as Record<string, unknown>).value).toBe("my-topic");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(({} as any).polluted).toBeUndefined();
  });
});
