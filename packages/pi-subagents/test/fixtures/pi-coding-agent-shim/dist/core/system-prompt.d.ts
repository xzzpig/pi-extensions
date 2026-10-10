/**
 * System prompt construction and project context loading
 */
import { type Skill } from "./skills.ts";
export interface BuildSystemPromptOptions {
    /** Custom system prompt (replaces default). */
    customPrompt?: string;
    /** Tools to include in prompt. Default: [read, bash, edit, write] */
    selectedTools?: string[];
    /** Optional one-line tool snippets keyed by tool name. */
    toolSnippets?: Record<string, string>;
    /** Additional guideline bullets appended to the default system prompt guidelines. */
    promptGuidelines?: string[];
    /** Text to append to system prompt. */
    appendSystemPrompt?: string;
    /** Working directory. */
    cwd: string;
    /** Pre-loaded context files. */
    contextFiles?: Array<{
        path: string;
        content: string;
    }>;
    /** Pre-loaded skills. */
    skills?: Skill[];
}
/** Pi 1.0.0: the normalized, collection-complete options shape carried by the
 * before_agent_start event's `systemPromptOptions` (selectedTools and sections
 * always present). Mirrors the real host's NormalizedBuildSystemPromptOptions. */
export type NormalizedBuildSystemPromptOptions = BuildSystemPromptOptions & {
    selectedTools: string[];
    toolSnippets: Record<string, string>;
    toolGuidelines: Record<string, string[]>;
    promptGuidelines: string[];
    appendSystemPrompt: string;
    sections: Record<string, string>;
    contextFiles: Array<{
        path: string;
        content: string;
    }>;
    skills: Skill[];
};
/** Build the system prompt with tools, guidelines, and context */
export declare function buildSystemPrompt(options: BuildSystemPromptOptions): string;
//# sourceMappingURL=system-prompt.d.ts.map