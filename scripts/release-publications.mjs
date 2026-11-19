import fs from "node:fs";
import { repository } from "./release-core.mjs";

export const repositoryUrl = repository.replace(/\.git$/, "");
const repositoryName = repositoryUrl.replace(/^https:\/\/github\.com\//, "");

export function publicationSource(env = process.env) {
  const {
    GITHUB_SHA: commit,
    GITHUB_RUN_ID: runId,
    GITHUB_RUN_ATTEMPT: attempt,
  } = env;
  if (
    env.GITHUB_REPOSITORY !== repositoryName ||
    env.GITHUB_REF !== "refs/heads/main" ||
    !/^[0-9a-f]{40}$/.test(commit ?? "") ||
    !/^[1-9]\d*$/.test(runId ?? "") ||
    !/^[1-9]\d*$/.test(attempt ?? "")
  )
    throw new Error("Expected the main publish workflow's GitHub context");
  return { commit, runId, attempt };
}

export function attemptUrl({ runId, attempt }) {
  return `${repositoryUrl}/actions/runs/${runId}/attempts/${attempt}`;
}

export function publicationTag({ name, version }) {
  return `${name.slice("@xzzpig/".length)}@${version}`;
}

export function reportPublications(source, publications, env = process.env) {
  const taggable = publications.filter(
    ({ status }) => status !== "integrity-mismatch",
  );
  if (taggable.length)
    fs.appendFileSync(
      env.GITHUB_OUTPUT,
      `publications=${JSON.stringify({ source, publications: taggable })}\n`,
    );
  const labels = {
    verified: "Registry verified",
    pending: "Registry confirmation pending",
    "integrity-mismatch": "Integrity mismatch (not tagged)",
  };
  const rows = publications.map(({ name, version, status }) => {
    const url = `https://www.npmjs.com/package/${name}/v/${version}`;
    return `| [${name}@${version}](${url}) | ${labels[status]} |`;
  });
  const { commit, attempt } = source;
  fs.appendFileSync(
    env.GITHUB_STEP_SUMMARY,
    [
      "## Actual npm uploads",
      "",
      `Source: [\`${commit}\`](${repositoryUrl}/commit/${commit}) · [Publish attempt ${attempt}](${attemptUrl(source)})`,
      "",
      ...(rows.length
        ? ["| npm version | Result |", "| --- | --- |", ...rows]
        : ["No versions uploaded by this attempt."]),
      "",
      "",
    ].join("\n"),
  );
}
