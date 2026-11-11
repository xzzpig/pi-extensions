// Read-only evidence oracle; run explicitly against a real Pi recording directory.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { parseGoalFile } from "../../extensions/storage/goal-files.ts";
import { buildTweakPresentation } from "../../extensions/goal-tweak-diff.ts";

const root = process.argv[2];
assert.ok(root && process.argv[3], "usage: node --experimental-strip-types tests/e2e/goal-tweak-live-assert.mjs <isolated-e2e-directory> <tmux-replay-history.txt>");
const entries = readdirSync(path.join(root, "sessions")).filter(file => file.endsWith(".jsonl")).flatMap(file =>
	readFileSync(path.join(root, "sessions", file), "utf8").trim().split("\n").map(line => JSON.parse(line)));
const reviews = entries.filter(entry => entry.message?.role === "toolResult" && entry.message.details?.tweakReview)
	.map(entry => ({ review: entry.message.details.tweakReview, text: entry.message.content.filter(part => part.type === "text").map(part => part.text).join("\n") }));
assert.deepEqual(reviews.map(row => row.review.outcome), ["continue", "cancel", "applied"]);
assert.match(reviews[0].text, /UI interaction test/);
assert.match(reviews[1].text, /cancelled.*current goal was not changed/);
for (const { review } of reviews) {
	assert.match(review.diffText, /- Objective:/);
	assert.match(review.diffText, /\+ Objective:/);
	assert.match(review.diffText, /sms verification contract/);
	assert.match(review.diffText, /50000/);
}
const goalDir = path.join(root, ".pi", "goals");
const goal = parseGoalFile(path.join(goalDir, readdirSync(goalDir).find(file => file.startsWith("active_goal_"))));
assert.equal(goal.tokenBudget, 50000);
assert.deepEqual(goal.taskList.tasks.map(task => task.id), ["login", "verify", "sms"]);
assert.equal(goal.skipAuditor, true);
assert.equal(reviews[2].review.fullText, buildTweakPresentation(goal, goal).fullText, "reviewed full candidate equals final disk business state");
const run = readFileSync(path.join(root, "current-run"), "utf8").trim();
assert.equal(readFileSync(path.join(run, "pi-exit"), "utf8").trim(), "0");
assert.equal(readFileSync(path.join(run, "recorder-exit"), "utf8").trim(), "0");
const cast = readFileSync(path.join(run, "session.cast"), "utf8").trim().split("\n").map(line => JSON.parse(line));
assert.equal(cast[0].version, 2);
assert.ok(cast.slice(1).some(row => row[1] === "o"));
const captures = readdirSync(run).filter(file => file.startsWith("pane-")).map(file => readFileSync(path.join(run, file), "utf8"));
captures.push(readFileSync(process.argv[3], "utf8"));
for (const marker of ["Confirm Goal Draft", "Goal tweak confirmation", "Modified goal — full effective content", "disabled -> enabled", "Continue chatting — refinement feedback", "Goal tweak — applied", "Modified goal (full):"]) {
	assert.ok(captures.some(text => text.includes(marker)), `recorded capture missing ${marker}`);
}
console.log(`PASS: ${reviews.length} real proposal outcomes, saved candidate/disk equivalence, rendered key states and complete v2 recording.`);
