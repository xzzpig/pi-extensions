/**
 * Per-channel health tracking for local feedback.
 *
 * The first failure of a channel produces one warning; repeated failures
 * stay silent; the first success after a failure produces one recovery
 * notice. State resets on configuration reload.
 */
export interface HealthRecord {
  ok: boolean;
  detail?: string;
}

export interface HealthReporter {
  record(channelId: string, result: HealthRecord): void;
  reset(): void;
}

export interface HealthTrackerOptions {
  onFailure(channelId: string, detail: string): void;
  onRecovery(channelId: string): void;
}

export function createHealthTracker(
  options: HealthTrackerOptions,
): HealthReporter {
  const failed = new Set<string>();

  return {
    record(channelId, result) {
      if (result.ok) {
        if (failed.delete(channelId)) {
          options.onRecovery(channelId);
        }
        return;
      }

      if (!failed.has(channelId)) {
        failed.add(channelId);
        options.onFailure(channelId, result.detail ?? "unknown error");
      }
    },
    reset() {
      failed.clear();
    },
  };
}
