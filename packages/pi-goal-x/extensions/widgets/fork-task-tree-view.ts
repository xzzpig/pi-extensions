import type { DashboardTaskNode } from "./goal-dashboard-model.ts";

/** A display-only projection. It never changes the underlying goal or tasks. */
export interface TaskTreeProjection {
  rows: DashboardTaskNode[];
  parents: Map<string, string | undefined>;
  expanded: Set<string>;
  anchor: string | undefined;
}

export function projectTaskTree(
  nodes: readonly DashboardTaskNode[],
  currentId: string | undefined,
  overrides: ReadonlyMap<string, boolean> = new Map(),
): TaskTreeProjection {
  const parents = new Map<string, string | undefined>();
  const stack: DashboardTaskNode[] = [];
  for (const node of nodes) {
    stack.length = node.depth;
    parents.set(node.id, stack[node.depth - 1]?.id);
    stack[node.depth] = node;
  }
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const expanded = new Set<string>();
  if (currentId && byId.has(currentId)) {
    let id = parents.get(currentId);
    while (id) {
      expanded.add(id);
      id = parents.get(id);
    }
    if (byId.get(currentId)!.totalSubtasks > 0) expanded.add(currentId);
  }
  for (const [id, open] of overrides) {
    if (!byId.get(id)?.totalSubtasks) continue;
    if (open) expanded.add(id);
    else expanded.delete(id);
  }
  const rows = nodes.filter((node) => {
    let id = parents.get(node.id);
    while (id) {
      if (!expanded.has(id)) return false;
      id = parents.get(id);
    }
    return true;
  });
  const visible = new Set(rows.map((node) => node.id));
  let anchor = currentId && byId.has(currentId) ? currentId : undefined;
  if (!anchor) {
    let latest: DashboardTaskNode | undefined;
    for (const node of nodes) {
      if (
        node.status === "complete" &&
        node.completedAt &&
        (!latest?.completedAt || node.completedAt > latest.completedAt)
      )
        latest = node;
    }
    anchor = latest?.id;
  }
  while (anchor && !visible.has(anchor)) anchor = parents.get(anchor);
  return { rows, parents, expanded, anchor: anchor ?? rows[0]?.id };
}

export type TaskViewMode = "compact" | "expanded";

/** Per-component display state, isolated from persisted task records. */
export class TaskTreeView {
  private goalId: string | undefined;
  private currentId: string | undefined;
  private initialized = false;
  private overrides = new Map<string, boolean>();
  private offsets: Record<TaskViewMode, number> = { compact: 0, expanded: 0 };
  private firstIds: Partial<Record<TaskViewMode, string>> = {};
  private follow = true;
  private projection: TaskTreeProjection = projectTaskTree([], undefined);

  update(
    goalId: string | undefined,
    currentId: string | undefined,
    nodes: readonly DashboardTaskNode[],
  ): TaskTreeProjection {
    if (
      !this.initialized ||
      goalId !== this.goalId ||
      currentId !== this.currentId
    ) {
      this.goalId = goalId;
      this.currentId = currentId;
      this.initialized = true;
      this.resetFollow();
    }
    const ids = new Set(nodes.map((node) => node.id));
    for (const id of this.overrides.keys())
      if (!ids.has(id)) this.overrides.delete(id);
    this.projection = projectTaskTree(nodes, currentId, this.overrides);
    return this.projection;
  }

  resetFollow(): void {
    this.overrides.clear();
    this.offsets = { compact: 0, expanded: 0 };
    this.firstIds = {};
    this.follow = true;
  }

  toggle(id: string): boolean {
    const row = this.projection.rows.find((node) => node.id === id);
    if (!row?.totalSubtasks) return false;
    this.overrides.set(id, !this.projection.expanded.has(id));
    this.follow = false;
    return true;
  }

  offset(mode: TaskViewMode, rows: number): number {
    const list = this.projection.rows;
    const count = Math.max(0, Math.floor(rows));
    const max = Math.max(0, list.length - count);
    let offset = this.offsets[mode];
    if (this.follow) {
      const index = list.findIndex(
        (node) => node.id === this.projection.anchor,
      );
      if (index >= 0 && count > 0) {
        if (index < offset) offset = index;
        if (index >= offset + count) offset = index - count + 1;
      }
    } else if (this.firstIds[mode]) {
      const index = list.findIndex((node) => node.id === this.firstIds[mode]);
      if (index >= 0) offset = index;
    }
    offset = Math.max(0, Math.min(max, offset));
    this.offsets[mode] = offset;
    this.firstIds[mode] = list[offset]?.id;
    return offset;
  }

  scroll(mode: TaskViewMode, rows: number, delta: number): number {
    const start = this.offset(mode, rows);
    this.follow = false;
    this.offsets[mode] = Math.max(
      0,
      Math.min(
        Math.max(0, this.projection.rows.length - Math.max(0, rows)),
        start + Math.trunc(delta),
      ),
    );
    this.firstIds[mode] = this.projection.rows[this.offsets[mode]]?.id;
    return this.offsets[mode];
  }
}
