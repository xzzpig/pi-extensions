import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { publishArtifacts } from "./release-core.mjs";
import {
  publicationSource,
  reportPublications,
} from "./release-publications.mjs";
import { publishTags } from "./release-tags.mjs";

const attemptEnv = {
  GITHUB_REPOSITORY: "xzzpig/pi-extensions",
  GITHUB_REF: "refs/heads/main",
  GITHUB_SHA: "a".repeat(40),
  GITHUB_RUN_ID: "123",
  GITHUB_RUN_ATTEMPT: "2",
};
const source = publicationSource(attemptEnv);
const integrity = `sha512-${Buffer.alloc(64).toString("base64")}`;
const artifact = (plugin) => ({
  name: `@xzzpig/pi-${plugin}`,
  version: "1.2.3",
  integrity,
});
const accepted = (plugin) => ({ ...artifact(plugin), status: "pending" });
const attemptUrl =
  "https://github.com/xzzpig/pi-extensions/actions/runs/123/attempts/2";

function summaryFiles(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-publications-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return {
    GITHUB_OUTPUT: path.join(dir, "output"),
    GITHUB_STEP_SUMMARY: path.join(dir, "summary"),
  };
}

for (const mismatch of [false, true]) {
  test(`partial publication retains accepted packages when a later ${mismatch ? "integrity check" : "upload"} fails`, async (t) => {
    const files = summaryFiles(t);
    const [verified, pending, skipped, failed, unreached] = [
      "verified",
      "pending",
      "skipped",
      "failed",
      "unreached",
    ].map(artifact);
    const uploaded = new Set([skipped.name]);
    const publications = [];
    await assert.rejects(
      async () => {
        try {
          await publishArtifacts(
            [verified, pending, skipped, failed, unreached],
            {
              lookup: async (name) =>
                uploaded.has(name)
                  ? {
                      dist: {
                        integrity: name === failed.name ? "wrong" : integrity,
                      },
                    }
                  : null,
              upload: async ({ name }) => {
                assert.notEqual(name, unreached.name);
                if (name === failed.name && !mismatch)
                  throw new Error("upload failed");
                if (name !== pending.name) uploaded.add(name);
              },
              onPublication: (entry) => publications.push(entry),
              report: () => {},
              warn: () => {},
            },
          );
        } finally {
          reportPublications(source, publications, files);
        }
      },
      mismatch ? /Registry integrity mismatch/ : /upload failed/,
    );
    const output = fs.readFileSync(files.GITHUB_OUTPUT, "utf8");
    assert.deepEqual(JSON.parse(output.slice("publications=".length)), {
      source,
      publications: [
        { ...verified, status: "verified" },
        { ...pending, status: "pending" },
      ],
    });
    const summary = fs.readFileSync(files.GITHUB_STEP_SUMMARY, "utf8");
    assert.ok(summary.includes(attemptUrl));
    assert.ok(summary.includes(`/commit/${source.commit}`));
    assert.match(summary, /pi-verified@1\.2\.3.*Registry verified/);
    assert.match(summary, /pi-pending@1\.2\.3.*Registry confirmation pending/);
    assert.doesNotMatch(summary, /pi-skipped|pi-unreached/);
    if (mismatch)
      assert.match(
        summary,
        /pi-failed@1\.2\.3.*Integrity mismatch \(not tagged\)/,
      );
    else assert.doesNotMatch(summary, /pi-failed/);
  });
}

test("an all-skipped release writes no tag-job output", (t) => {
  const files = summaryFiles(t);
  reportPublications(source, [], files);
  assert.equal(fs.existsSync(files.GITHUB_OUTPUT), false);
  assert.match(
    fs.readFileSync(files.GITHUB_STEP_SUMMARY, "utf8"),
    /No versions uploaded/,
  );
});

test("annotated tag points at the original commit and keeps its attempt when the tag job retries", async () => {
  const tagSha = "b".repeat(40);
  const calls = [];
  const results = [];
  const options = {
    context: { ...source, attempt: "3" },
    request: async (resource, body) => {
      calls.push([resource, body]);
      if (resource.startsWith("/git/ref/"))
        return calls.length === 1
          ? null
          : { object: { type: "tag", sha: tagSha } };
      if (resource === `/git/tags/${tagSha}`)
        return {
          object: { sha: source.commit, type: "commit" },
          message: calls[1][1].message,
        };
      return { sha: tagSha };
    },
    report: (...args) => results.push(args),
  };
  const receipt = { source, publications: [accepted("goal-x")] };
  await publishTags(receipt, options);
  assert.deepEqual(calls, [
    ["/git/ref/tags/pi-goal-x%401.2.3", undefined],
    [
      "/git/tags",
      {
        tag: "pi-goal-x@1.2.3",
        object: source.commit,
        type: "commit",
        message: `npm publish @xzzpig/pi-goal-x@1.2.3\n\nAction: ${attemptUrl}\nTarball integrity: ${integrity}`,
      },
    ],
    ["/git/refs", { ref: "refs/tags/pi-goal-x@1.2.3", sha: tagSha }],
  ]);
  await publishTags(receipt, options);
  assert.equal(calls.length, 5);
  assert.deepEqual(results, [
    ["pi-goal-x@1.2.3", "Created"],
    ["pi-goal-x@1.2.3", "Already recorded"],
  ]);
});

test("tag conflicts are not overwritten and do not prevent later tags", async (t) => {
  t.mock.method(console, "error", () => {});
  const calls = [];
  const results = [];
  await assert.rejects(
    publishTags(
      { source, publications: [accepted("conflict"), accepted("other")] },
      {
        context: source,
        request: async (resource, body) => {
          calls.push([resource, body]);
          if (resource.includes("pi-conflict"))
            return { object: { type: "commit", sha: source.commit } };
          return body ? { sha: "b".repeat(40) } : null;
        },
        report: (...args) => results.push(args),
      },
    ),
    /tag creation failed for pi-conflict@1\.2\.3/,
  );
  assert.equal(calls.filter(([, body]) => body).length, 2);
  assert.deepEqual(results, [
    ["pi-conflict@1.2.3", "Failed"],
    ["pi-other@1.2.3", "Created"],
  ]);
});

test("tag writer refuses unrelated commits, attempts and integrity mismatches before any API requests", async () => {
  const options = {
    context: source,
    request: () => assert.fail("unexpected API call"),
  };
  for (const receipt of [
    {
      source: { ...source, commit: "b".repeat(40) },
      publications: [accepted("goal-x")],
    },
    { source: { ...source, attempt: "3" }, publications: [accepted("goal-x")] },
    {
      source,
      publications: [{ ...accepted("goal-x"), status: "integrity-mismatch" }],
    },
  ])
    await assert.rejects(
      publishTags(receipt, options),
      /Invalid npm publication records/,
    );
});
