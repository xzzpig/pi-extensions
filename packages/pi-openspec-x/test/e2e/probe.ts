/**
 * E2E observation probe (task 7.1).
 *
 * This file exists only so the live acceptance run can read back what the main
 * session's tool surface actually looked like. It observes and nothing else:
 * it registers no tools, touches no business state, and never throws into the
 * run. It is not part of the published package (`files` lists only `index.ts`,
 * `src`, and the top-level docs), and vitest does not collect it because it is
 * not a `*.test.ts`.
 *
 * The payload is `pi-openspec-x-e2e/surface` (version 1 in the payload, per the
 * repository's customType convention) and carries `reportSurface`, which is
 * what the E1/E1b assertions in `e2e.md` read.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const SURFACE_ENTRY = "pi-openspec-x-e2e/surface";
export const SURFACE_VERSION = 1;

/** The three role-scoped reporting tools this change is isolating. */
const REPORT_TOOLS = [
  "report_gap_analysis",
  "report_plan_review",
  "report_work",
];

/** The parent-side plan tools that must stay registered on the main session. */
const PARENT_TOOLS = ["opsx_plan_gap_analysis", "opsx_plan_verdict"];

/**
 * Phrases that only appear when a reporting tool's `promptSnippet` or
 * `promptGuidelines` reached the system prompt. Hiding the tools must clear
 * these too, so their absence is asserted separately from the tool list.
 */
const REPORT_RULE_MARKERS = [
  "Submit the structured pre-planning gap analysis",
  "Submit the structured plan review",
  "Submit the structured completion report",
  "Call it again whenever the analysis changes",
  "REJECT carries at most 3 blocking issues",
];

export interface SurfaceSnapshot {
  version: number;
  reportSurface: {
    registered: string[];
    active: string[];
    promptMentions: string[];
  };
  parentToolsPresent: string[];
  systemPromptHasReportRules: boolean;
  registeredCount: number;
  activeCount: number;
  systemPromptLength: number;
}

function registeredNames(pi: ExtensionAPI): string[] {
  try {
    return pi.getAllTools().map((tool) => tool.name);
  } catch {
    return [];
  }
}

function activeNames(pi: ExtensionAPI): string[] {
  try {
    return pi.getActiveTools();
  } catch {
    return [];
  }
}

export function readSurface(
  pi: ExtensionAPI,
  systemPrompt?: string,
): SurfaceSnapshot {
  const registered = registeredNames(pi);
  const active = activeNames(pi);
  const text = typeof systemPrompt === "string" ? systemPrompt : "";
  return {
    version: SURFACE_VERSION,
    // Empty when isolation holds: the report tools must appear in none of these.
    reportSurface: {
      registered: registered.filter((name) => REPORT_TOOLS.includes(name)),
      active: active.filter((name) => REPORT_TOOLS.includes(name)),
      promptMentions: REPORT_TOOLS.filter((name) => text.includes(name)),
    },
    parentToolsPresent: PARENT_TOOLS.filter((name) =>
      registered.includes(name),
    ),
    systemPromptHasReportRules: REPORT_RULE_MARKERS.some((marker) =>
      text.includes(marker),
    ),
    registeredCount: registered.length,
    activeCount: active.length,
    systemPromptLength: text.length,
  };
}

export default function probeExtension(pi: ExtensionAPI): void {
  const write = (phase: string, systemPrompt?: string): void => {
    try {
      pi.appendEntry(SURFACE_ENTRY, {
        phase,
        ...readSurface(pi, systemPrompt),
      });
    } catch {
      // Observation only. A probe that breaks the run it measures is worse
      // than no probe, so every failure is swallowed.
    }
  };

  pi.on("session_start", () => write("session_start"));
  pi.on("before_agent_start", (event) =>
    write("before_agent_start", event.systemPrompt),
  );
  pi.on("turn_end", () => write("turn_end"));
}
