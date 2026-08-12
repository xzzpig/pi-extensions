const HERDR_BLOCKED_EVENT = "herdr:blocked";

export interface EventBus {
  emit(channel: string, data: unknown): unknown;
}

export interface InteractionState {
  activeCount(): number;
  completeAsk(flowId: string): boolean;
  resolvePermission(requestId: string): boolean;
  shutdown(): void;
  startAsk(flowId: string, label: string): boolean;
  startPermission(requestId: string, label: string): boolean;
}

export function createInteractionState(events: EventBus): InteractionState {
  const activeAskFlows = new Set<string>();
  const activePermissionRequests = new Set<string>();
  let blocked = false;

  const activeCount = (): number =>
    activeAskFlows.size + activePermissionRequests.size;

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
    if (activeCount() !== 0 || !blocked) {
      return;
    }

    blocked = false;
    emit(HERDR_BLOCKED_EVENT, { active: false });
  };

  return {
    activeCount,
    completeAsk(flowId) {
      if (!activeAskFlows.delete(flowId)) {
        return false;
      }

      emitUnblockedWhenIdle();
      return true;
    },
    resolvePermission(requestId) {
      if (!activePermissionRequests.delete(requestId)) {
        return false;
      }

      emitUnblockedWhenIdle();
      return true;
    },
    shutdown() {
      activeAskFlows.clear();
      activePermissionRequests.clear();
      emitUnblockedWhenIdle();
    },
    startAsk(flowId, label) {
      if (activeAskFlows.has(flowId)) {
        return false;
      }

      activeAskFlows.add(flowId);
      emitBlocked(label);
      return true;
    },
    startPermission(requestId, label) {
      if (activePermissionRequests.has(requestId)) {
        return false;
      }

      activePermissionRequests.add(requestId);
      emitBlocked(label);
      return true;
    },
  };
}
