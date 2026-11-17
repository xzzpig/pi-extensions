import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import {
  SUBAGENT_DELEGATION_REQUEST_EVENT,
  SUBAGENT_DELEGATION_UPDATE_EVENT,
  SUBAGENT_DELEGATION_RESPONSE_EVENT,
} from "@xzzpig/pi-subagents/delegation";
import {
  createHarness,
  start,
} from "./fixtures/fork-audit-completion-harness.ts";
import { AUDIT_PROGRESS_V2_PREFIX } from "../extensions/fork-audit-progress.ts";
import { goalLedgerPath } from "../extensions/goal-ledger.ts";

const cases = [
  { state: "pending", verdict: "approved", complete: true },
  { state: "running", verdict: "approved", complete: true },
  { state: "failed", verdict: "approved", complete: true },
  { state: "passed", verdict: "disapproved", complete: false },
  { state: "passed", verdict: "error", complete: false },
  { state: "passed", verdict: "invalid", complete: false },
  { state: "invalid", verdict: "approved", complete: true },
] as const;

for (const scenario of cases)
  test(`completion transaction ignores display state=${scenario.state}, verdict=${scenario.verdict}`, async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "goal-checklist-gate-"));
    try {
      mkdirSync(path.join(cwd, ".pi", "goals", "archived"), {
        recursive: true,
      });
      const h = createHarness(cwd);
      writeFileSync(
        path.join(cwd, ".pi", "pi-goal-x-settings.json"),
        JSON.stringify({
          auditor: {
            disabled: false,
            checklist: ["Verify deliverable"],
            changeManifest: "off",
          },
        }),
      );
      let launches = 0;
      let observedState: string | undefined;
      h.events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, (value) => {
        launches++;
        const request = value as {
          requestId: string;
          ownerRunId: string;
          nodeId: string;
        };
        if (scenario.state !== "pending") {
          h.events.emit(SUBAGENT_DELEGATION_UPDATE_EVENT, {
            ...request,
            recentOutputLines: [
              AUDIT_PROGRESS_V2_PREFIX +
                JSON.stringify({
                  sequence: 1,
                  checkId: "checklist-1",
                  state: scenario.state,
                  detail: "Fixture evidence",
                }),
            ],
          });
        }
        observedState = h.core.auditProgress?.checks?.[0]?.state;
        h.events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
          ...request,
          status: scenario.verdict === "error" ? "failed" : "completed",
          error:
            scenario.verdict === "error"
              ? "Fixture runtime failure"
              : undefined,
          result: {
            kind: "structured",
            value: {
              verdict: scenario.verdict,
              report: "Fixture audit report",
              findings: [],
            },
          },
        });
      });
      await start(h);
      const tool = h.tools.get("update_goal");
      assert.ok(tool);
      await tool.execute(
        "complete",
        { status: "complete" },
        new AbortController().signal,
        undefined,
        h.ctx as ExtensionToolContext,
      );
      assert.equal(launches, 1);
      assert.equal(
        observedState,
        scenario.state === "invalid" ? "pending" : scenario.state,
      );
      assert.equal(
        h.core.state.goal?.status,
        scenario.complete ? "complete" : "active",
      );
      const entries = readFileSync(goalLedgerPath({ cwd }), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { type: string; verdict?: string });
      assert.equal(entries.filter((e) => e.type === "audit_started").length, 1);
      const results = entries.filter((e) => e.type === "audit_result");
      assert.equal(results.length, 1);
      assert.equal(
        results[0]?.verdict,
        scenario.verdict === "invalid" || scenario.verdict === "error"
          ? "error"
          : scenario.verdict,
      );
      assert.equal(entries.filter((e) => e.type === "audit_skipped").length, 0);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
