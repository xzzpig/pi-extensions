import { describe, expect, test } from "vitest";
import { renderLegacyMessage } from "#src/presentation/legacy-message";
import {
  buildSkillAskPayload,
  buildSkillPathAskPayload,
} from "#src/presentation/skill-ask-payload";
import type { SkillPromptEntry } from "#src/skill-prompt-sanitizer";

function skillEntry(name: string): SkillPromptEntry {
  return {
    name,
    description: "A skill",
    location: `/skills/${name}/SKILL.md`,
    state: "ask",
    normalizedLocation: `/skills/${name}/SKILL.md`,
    normalizedBaseDir: `/skills/${name}`,
  };
}

describe("buildSkillAskPayload", () => {
  test("makes the skill the decision-relevant value", () => {
    const payload = buildSkillAskPayload("librarian", "my-agent");

    expect(payload.kind).toBe("skill");
    expect(payload.request).toEqual({
      requester: { agentName: "my-agent", forwarded: false, sessionId: null },
      surface: "skill",
      toolName: null,
      invokedToolName: null,
      value: "librarian",
      matchedPattern: null,
      commandContext: null,
      executedUnit: null,
    });
    expect(payload.evidence).toEqual([]);
  });

  test("includes skill name and agent name", () => {
    const result = renderLegacyMessage(
      buildSkillAskPayload("librarian", "my-agent"),
    );
    expect(result).toContain("librarian");
    expect(result).toContain("Agent 'my-agent'");
  });

  test("uses 'Current agent' without agent name", () => {
    const result = renderLegacyMessage(buildSkillAskPayload("librarian", null));
    expect(result).toContain("Current agent");
    expect(result).toContain("librarian");
  });
});

describe("buildSkillPathAskPayload", () => {
  test("keeps the skill as the value and the path as evidence", () => {
    const payload = buildSkillPathAskPayload(
      skillEntry("librarian"),
      "/skills/librarian/SKILL.md",
      null,
    );

    expect(payload.kind).toBe("skill_read");
    expect(payload.request.value).toBe("librarian");
    expect(payload.evidence).toEqual([
      {
        label: "read path",
        text: "/skills/librarian/SKILL.md",
        detail: null,
      },
    ]);
  });

  test("includes skill name, read path, and agent name", () => {
    const result = renderLegacyMessage(
      buildSkillPathAskPayload(
        skillEntry("librarian"),
        "/skills/librarian/SKILL.md",
        "my-agent",
      ),
    );
    expect(result).toContain("librarian");
    expect(result).toContain("/skills/librarian/SKILL.md");
    expect(result).toContain("Agent 'my-agent'");
  });

  test("uses 'Current agent' without agent name", () => {
    expect(
      renderLegacyMessage(
        buildSkillPathAskPayload(
          skillEntry("librarian"),
          "/skills/librarian/SKILL.md",
          null,
        ),
      ),
    ).toContain("Current agent");
  });
});
