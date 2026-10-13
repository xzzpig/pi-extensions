/**
 * Canonical records produced by the REAL runtime under a deterministic fake model (design D2,
 * task 2.2).
 *
 * The reader's other fixtures are built through the host's own `SessionManager.appendMessage`, which
 * proves the reader accepts that API but not that it accepts what a live agent turn actually
 * persists. Here a real `AgentSession` runs one turn against a stub provider whose stream is canned,
 * so the session file is written by the production path: no network, no credentials, no human
 * confirmation.
 */
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  createAgentSession,
} from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

const PROVIDER = "opsx-fake-model";
const MODEL_ID = "fake-1";
const API = "opsx-fake-api";
const REPLY = "fake acknowledgement";

/** A canned assistant turn: no network, and identical on every run. */
function cannedStream(model: { api: string; provider: string; id: string }) {
  const stream = createAssistantMessageEventStream();
  const message: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: REPLY }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
  queueMicrotask(() => {
    stream.push({ type: "start", partial: message });
    stream.end(message);
  });
  return stream;
}

const temporaryDirs: string[] = [];

afterEach(() => {
  for (const dir of temporaryDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirs.push(dir);
  return dir;
}

describe("canonical records from a real session under a deterministic fake model", () => {
  test("a real turn persists records the reader's strict parser accepts", async () => {
    const cwd = tempDir("opsx-fake-cwd-");
    const agentDir = tempDir("opsx-fake-agent-");
    const sessionDir = tempDir("opsx-fake-sessions-");

    const modelRuntime = await ModelRuntime.create({ refreshOnCreate: false });
    modelRuntime.registerProvider(PROVIDER, {
      api: API,
      baseUrl: "http://127.0.0.1:1/unused",
      apiKey: "unused",
      models: [
        {
          id: MODEL_ID,
          name: "Fake",
          api: API,
          input: ["text"],
          output: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 64000,
        },
      ],
      streamSimple: (model: { api: string; provider: string; id: string }) =>
        cannedStream(model),
    } as never);

    const model = modelRuntime.getModel(PROVIDER, MODEL_ID);
    expect(model).toBeTruthy();

    const manager = SessionManager.create(cwd, sessionDir);
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      noExtensions: true,
    });
    await resourceLoader.reload();

    const { session } = await createAgentSession({
      cwd,
      agentDir,
      model: model!,
      modelRuntime,
      sessionManager: manager,
      resourceLoader,
      initialActiveToolNames: [],
    } as never);

    try {
      await session.prompt("ping");
    } finally {
      session.dispose();
    }

    // The record was written by the production path, not by a hand-built fixture.
    const file = manager.getSessionFile();
    expect(file).toBeTruthy();
    const lines = fs
      .readFileSync(file!, "utf-8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(lines[0]?.type).toBe("session");
    expect(lines[0]?.version).toBe(3);
    const messages = lines.filter((entry) => entry.type === "message");
    expect(messages.length).toBeGreaterThan(0);
    const assistant = messages.find(
      (entry) =>
        (entry.message as { role?: string } | undefined)?.role === "assistant",
    );
    expect(assistant).toBeTruthy();
    const content = (
      assistant!.message as { content?: Array<{ type: string; text?: string }> }
    ).content;
    expect(content?.some((part) => part.text === REPLY)).toBe(true);

    // The reader enforces these structural invariants before it trusts a record
    // (strict JSON lines, v3 header, unique non-empty ids, a resolvable parent
    // chain). Verify a real-runtime record actually satisfies them, so the
    // reader's fixtures are not the only shape it is known to accept.
    const header = lines[0]!;
    expect(header.type).toBe("session");
    expect(header.version).toBe(3);
    // A real header also carries an `id`; the reader skips the header entirely,
    // so it is never registered as an entry id.
    const entries = lines.slice(1);
    const ids = new Set<string>();
    for (const entry of entries) {
      expect(typeof entry.id).toBe("string");
      const id = entry.id as string;
      expect(id.length).toBeGreaterThan(0);
      expect(ids.has(id)).toBe(false);
      ids.add(id);
    }
    for (const entry of entries) {
      const parentId = entry.parentId;
      if (parentId !== null && parentId !== undefined) {
        expect(typeof parentId).toBe("string");
        expect(ids.has(parentId as string)).toBe(true);
      }
    }
  }, 60_000);
});
