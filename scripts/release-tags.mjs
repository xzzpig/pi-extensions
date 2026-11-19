#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stable } from "./release-core.mjs";
import {
  attemptUrl,
  publicationSource,
  publicationTag,
  repositoryUrl,
} from "./release-publications.mjs";

async function publishTag(request, tag, commit, message) {
  const ref = `refs/tags/${tag}`;
  const existing = await request(`/git/ref/tags/${encodeURIComponent(tag)}`);
  if (existing) {
    if (existing.object.type === "tag") {
      const saved = await request(`/git/tags/${existing.object.sha}`);
      if (
        saved?.object.type === "commit" &&
        saved.object.sha === commit &&
        saved.message.trimEnd() === message
      )
        return "Already recorded";
    }
    throw new Error(`Conflicting ${ref}; refusing to overwrite it`);
  }

  const annotation = await request("/git/tags", {
    tag,
    message,
    object: commit,
    type: "commit",
  });
  await request("/git/refs", { ref, sha: annotation.sha });
  return "Created";
}

export async function publishTags(
  { source, publications },
  { context, request, report },
) {
  if (
    source?.commit !== context.commit ||
    source.runId !== context.runId ||
    !/^[1-9]\d*$/.test(source.attempt ?? "") ||
    BigInt(source.attempt) > BigInt(context.attempt) ||
    !Array.isArray(publications) ||
    !publications.length ||
    !publications.every(
      ({ name, version, integrity, status }) =>
        /^@xzzpig\/pi-[a-z0-9][a-z0-9-]*$/.test(name) &&
        stable(version) &&
        /^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity) &&
        ["verified", "pending"].includes(status),
    )
  )
    throw new Error("Invalid npm publication records for this workflow run");

  const failures = [];
  for (const entry of publications) {
    const tag = publicationTag(entry);
    const message = [
      `npm publish ${entry.name}@${entry.version}`,
      "",
      `Action: ${attemptUrl(source)}`,
      `Tarball integrity: ${entry.integrity}`,
    ].join("\n");
    let result;
    try {
      result = await publishTag(request, tag, source.commit, message);
    } catch (error) {
      failures.push(tag);
      console.error(`${tag}: ${error.message}`);
      report(tag, "Failed");
      continue;
    }
    report(tag, result);
  }
  if (failures.length)
    throw new Error(
      `npm uploads already accepted; tag creation failed for ${failures.join(", ")}`,
    );
}

async function main() {
  const context = publicationSource();
  const token = process.env.GH_TOKEN;
  if (!token) throw new Error("Missing GitHub tag-writer token");
  const request = async (resource, body) => {
    const res = await fetch(
      `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}${resource}`,
      {
        method: body ? "POST" : "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      },
    );
    if (!body && res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub ${resource}: HTTP ${res.status}`);
    return res.json();
  };
  const lines = [
    "## npm publication tags",
    "",
    "| Tag | Result |",
    "| --- | --- |",
  ];
  try {
    await publishTags(JSON.parse(process.env.NPM_PUBLICATIONS), {
      context,
      request,
      report: (tag, result) =>
        lines.push(
          `| ${result === "Failed" ? tag : `[${tag}](${repositoryUrl}/tree/${encodeURIComponent(tag)})`} | ${result} |`,
        ),
    });
  } finally {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
