import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";
import { MouseRegion, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { tidyEnabled } from "../src/live.ts";
import {
  messageKey,
  turnFor,
  turnOptions,
  type TurnMessage,
} from "../src/turns/turn-state.ts";

const GROUP_BOUNDARY = Symbol.for("pi-toolbox:group-boundary");
const TURN_MOUSE = Symbol.for("pi-tidy:turn-mouse");
const FORK_RENDER = Symbol.for("pi-tidy:fork-thinking-row-render");
const FORK_MOUSE = Symbol.for("pi-tidy:fork-thinking-row-mouse");

interface ThinkingRow {
  region: MouseRegion;
  start: number;
  height: number;
}

interface ThinkingRows {
  lines: string[];
  entries: ThinkingRow[];
}

const rowsByComponent = new WeakMap<AssistantMessageComponent, ThinkingRows>();
const wrappedMouseHandlers = new WeakSet<Function>();

interface AssistantInternals {
  lastMessage: unknown;
  contentContainer: { children: unknown[] };
  hideThinkingBlock: boolean;
}

function assistantInternals(
  component: AssistantMessageComponent,
): AssistantInternals {
  // SAFETY: Pi 1.5 declares these renderer fields private, but its own final-reply renderer reads the same runtime fields.
  return component as unknown as AssistantInternals;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isTurnMessage(value: unknown): value is TurnMessage {
  return (
    isRecord(value) &&
    typeof value.role === "string" &&
    Array.isArray(value.content)
  );
}

function isThinkingBlock(
  value: unknown,
): value is { type: "thinking"; thinking: string } {
  return (
    isRecord(value) &&
    value.type === "thinking" &&
    typeof value.thinking === "string" &&
    value.thinking.trim().length > 0
  );
}

function readLastMessage(
  component: AssistantMessageComponent,
): TurnMessage | undefined {
  const message = assistantInternals(component).lastMessage;
  return isTurnMessage(message) ? message : undefined;
}

function hasThinking(message: TurnMessage | undefined): boolean {
  return Boolean(message?.content.some(isThinkingBlock));
}

function isFramedFinalReply(
  component: AssistantMessageComponent,
): boolean {
  const message = readLastMessage(component);
  const key = messageKey(message);
  const turn = turnFor(message);
  return Boolean(
    tidyEnabled.get() &&
      turnOptions.get().frameFinalReply &&
      key &&
      turn?.final === key &&
      hasThinking(message),
  );
}

function childComponents(
  component: AssistantMessageComponent,
): unknown[] {
  return assistantInternals(component).contentContainer.children;
}

function isMouseRegion(value: unknown): value is MouseRegion {
  if (value instanceof MouseRegion) return true;
  if (!isRecord(value)) return false;
  return (
    typeof value.constructor === "function" &&
    value.constructor.name === "MouseRegion" &&
    typeof value.render === "function" &&
    typeof value.handleMouse === "function"
  );
}

function thinkingRegions(component: AssistantMessageComponent): MouseRegion[] {
  return childComponents(component).filter(isMouseRegion);
}

function hasHiddenThinking(component: AssistantMessageComponent): boolean {
  return assistantInternals(component).hideThinkingBlock === true;
}

function buildThinkingRows(
  component: AssistantMessageComponent,
  width: number,
): ThinkingRows | undefined {
  // pi-tidy's framed-final-reply path intentionally omits thinking children.
  // Restore only the settled, hidden Pi MouseRegions: streaming output remains
  // owned by Pi and the row keeps Pi's own click-to-expand behavior.
  if (
    !isFramedFinalReply(component) ||
    !hasHiddenThinking(component)
  ) {
    return undefined;
  }

  const lines: string[] = [];
  const entries: ThinkingRow[] = [];
  for (const region of thinkingRegions(component)) {
    const row = region.render(width);
    if (row.length === 0) continue;
    if (lines.length > 0) lines.push("");
    entries.push({ region, start: lines.length, height: row.length });
    lines.push(...row);
  }
  return entries.length > 0 ? { lines, entries } : undefined;
}

function installMouseAdapter(component: AssistantMessageComponent): void {
  const previous = component.handleMouse;
  if (typeof previous !== "function" || wrappedMouseHandlers.has(previous)) return;

  const wrapped = function (
    this: AssistantMessageComponent,
    event: TuiMouseEvent,
  ): ReturnType<AssistantMessageComponent["handleMouse"]> {
    const rows = rowsByComponent.get(this);
    if (!rows) return previous.call(this, event);

    const row = rows.entries.find(
      (entry) => event.y >= entry.start && event.y < entry.start + entry.height,
    );
    if (row) {
      const rowEvent = {
        ...event,
        y: event.y - row.start,
        height: row.height,
      };
      const result = row.region.handleMouse(rowEvent);
      if (!result?.handled) return undefined;
      if ("target" in result) return result;
      return {
        ...result,
        handled: true,
        target: {
          component: row.region,
          originX: 0,
          originY: row.start,
          width: event.width,
          height: row.height,
        },
      };
    }

    if (event.y >= rows.lines.length) {
      return previous.call(this, {
        ...event,
        y: event.y - rows.lines.length,
        height: Math.max(0, event.height - rows.lines.length),
      });
    }
    return undefined;
  };

  wrappedMouseHandlers.add(wrapped);
  Object.defineProperty(wrapped, FORK_MOUSE, { value: true });
  // Let pi-tidy's own renderer keep this outer wrapper on subsequent renders.
  Object.defineProperty(wrapped, TURN_MOUSE, { value: true });
  component.handleMouse = wrapped;
}

/** Install after pi-tidy's boundary renderer so its final-frame suppression can be composed. */
export function installForkThinkingRows(): void {
  const prototype = AssistantMessageComponent.prototype;
  const previous = prototype.render;
  if (typeof previous !== "function" || Object.hasOwn(previous, FORK_RENDER)) return;

  const wrapped = function (
    this: AssistantMessageComponent,
    width: number,
  ): string[] {
    const rendered = previous.call(this, width);
    const rows = buildThinkingRows(this, width);
    if (!rows || rendered.length === 0) {
      rowsByComponent.delete(this);
      return rendered;
    }
    rowsByComponent.set(this, rows);
    installMouseAdapter(this);
    return [...rows.lines, ...rendered];
  };

  Object.defineProperty(wrapped, FORK_RENDER, { value: true });
  // pi-tidy's installGroupBoundaries checks this marker before wrapping again.
  Object.defineProperty(wrapped, GROUP_BOUNDARY, { value: true });
  prototype.render = wrapped;
}
