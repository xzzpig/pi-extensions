/**
 * Herdr blocked-state machine for UI wait spans.
 *
 * The generic UI-prompt adapter is the ONLY source of wait items: each
 * accepted `ui_prompt_start` opens one span, and its `ui_prompt_end` closes
 * it. The first active span emits `herdr:blocked`; the state releases only
 * when every span completes or the session shuts down. Emissions are
 * observational and must never interrupt Pi.
 */
const HERDR_BLOCKED_EVENT = "herdr:blocked";

export interface EventBus {
  emit(channel: string, data: unknown): void;
}

export interface InteractionState {
  activeCount(): number;
  completeUiPrompt(spanId: string): boolean;
  shutdown(): void;
  startUiPrompt(spanId: string, label: string): boolean;
}

export function createInteractionState(events: EventBus): InteractionState {
  const activeSpans = new Set<string>();
  let blocked = false;

  const emit = (channel: string, data: unknown): void => {
    try {
      events.emit(channel, data);
    } catch {
      // State broadcasts are observational and must not interrupt Pi.
    }
  };

  const emitBlocked = (label: string): void => {
    if (blocked) {
      return;
    }

    blocked = true;
    emit(HERDR_BLOCKED_EVENT, { active: true, label });
  };

  const emitUnblockedWhenIdle = (): void => {
    if (activeSpans.size !== 0 || !blocked) {
      return;
    }

    blocked = false;
    emit(HERDR_BLOCKED_EVENT, { active: false });
  };

  return {
    activeCount: () => activeSpans.size,
    completeUiPrompt(spanId) {
      if (!activeSpans.delete(spanId)) {
        return false;
      }

      emitUnblockedWhenIdle();
      return true;
    },
    shutdown() {
      activeSpans.clear();
      emitUnblockedWhenIdle();
    },
    startUiPrompt(spanId, label) {
      if (activeSpans.has(spanId)) {
        return false;
      }

      activeSpans.add(spanId);
      emitBlocked(label);
      return true;
    },
  };
}
