import type {
  HistoryEntry,
  HistorySink,
  RuleRunner,
  RunnerStatus,
} from "./runner.js";

/**
 * Shared observability store.
 *
 * `SentinelRegistry` is the single data source for `/sentinel:list`, the fleet
 * inspector, and the configuration dialog: runner live state, the most recent
 * audit records (rolling window of 20), and configuration-dialog transcripts.
 */

export const MAX_HISTORY = 20;

export interface DialogTranscriptEntry {
  role: "user" | "assistant" | "system";
  text: string;
  at: number;
}

export interface ConfigureDialogView {
  id: string;
  startedAt: number;
  turnCount: number;
  status: "running" | "done";
  transcript: DialogTranscriptEntry[];
  draftSummary?: string;
}

export class SentinelRegistry implements HistorySink {
  private readonly history: HistoryEntry[] = [];
  private runners = new Map<string, RuleRunner>();
  private readonly dialogs = new Map<string, ConfigureDialogView>();

  record(entry: HistoryEntry): void {
    this.history.push(entry);
    if (this.history.length > MAX_HISTORY) {
      this.history.splice(0, this.history.length - MAX_HISTORY);
    }
  }

  getHistory(): HistoryEntry[] {
    return [...this.history];
  }

  clearHistory(): void {
    this.history.length = 0;
  }

  setRunners(runners: Map<string, RuleRunner>): void {
    this.runners = runners;
  }

  getRunner(name: string): RuleRunner | undefined {
    return this.runners.get(name);
  }

  runnerNames(): string[] {
    return [...this.runners.keys()];
  }

  statuses(): RunnerStatus[] {
    return [...this.runners.values()].map((runner) => runner.status());
  }

  /** Number of audits currently executing across all rules. */
  runningCount(): number {
    return [...this.runners.values()].reduce(
      (total, runner) => total + runner.status().activeCount,
      0,
    );
  }

  registerDialog(view: ConfigureDialogView): void {
    this.dialogs.set(view.id, view);
  }

  updateDialog(id: string, patch: Partial<ConfigureDialogView>): void {
    const current = this.dialogs.get(id);
    if (!current) return;
    this.dialogs.set(id, { ...current, ...patch });
  }

  appendDialogEntry(id: string, entry: DialogTranscriptEntry): void {
    const current = this.dialogs.get(id);
    if (!current) return;
    current.transcript.push(entry);
    this.dialogs.set(id, current);
  }

  removeDialog(id: string): void {
    this.dialogs.delete(id);
  }

  dialogsView(): ConfigureDialogView[] {
    return [...this.dialogs.values()];
  }

  clearDialogs(): void {
    this.dialogs.clear();
  }
}
