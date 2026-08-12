/**
 * Routing-level deduplication for interaction events.
 *
 * pi-ask flows and permission prompts may publish repeated lifecycle events;
 * notification events are emitted once per newly-activated flow/request.
 * This tracker is independent of the Herdr blocked-state machine, so the
 * notification routing never depends on `herdr.enabled`.
 */
export interface InteractionRoutingTracker {
  startAsk(flowId: string): boolean;
  startPermission(requestId: string): boolean;
  completeAsk(flowId: string): boolean;
  completePermission(requestId: string): boolean;
  reset(): void;
}

export function createInteractionRoutingTracker(): InteractionRoutingTracker {
  const activeAskFlows = new Set<string>();
  const activePermissionRequests = new Set<string>();

  return {
    startAsk(flowId) {
      if (activeAskFlows.has(flowId)) {
        return false;
      }
      activeAskFlows.add(flowId);
      return true;
    },
    startPermission(requestId) {
      if (activePermissionRequests.has(requestId)) {
        return false;
      }
      activePermissionRequests.add(requestId);
      return true;
    },
    completeAsk(flowId) {
      return activeAskFlows.delete(flowId);
    },
    completePermission(requestId) {
      return activePermissionRequests.delete(requestId);
    },
    reset() {
      activeAskFlows.clear();
      activePermissionRequests.clear();
    },
  };
}
