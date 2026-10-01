import type { ContainerId, PermissionDecision, PermissionRecord } from "./model";

export class PermissionStore {
  constructor(private readonly records: PermissionRecord[]) {}

  decision(containerId: ContainerId, origin: string, permission: string): PermissionDecision {
    return this.records.find(
      (record) =>
        record.containerId === containerId &&
        record.origin === origin &&
        record.permission === permission,
    )?.decision ?? "ask";
  }

  set(containerId: ContainerId, origin: string, permission: string, decision: PermissionDecision): void {
    const existing = this.records.find(
      (record) =>
        record.containerId === containerId &&
        record.origin === origin &&
        record.permission === permission,
    );
    if (existing) {
      existing.decision = decision;
      existing.updatedAt = Date.now();
      return;
    }
    this.records.push({
      containerId,
      origin,
      permission,
      decision,
      updatedAt: Date.now(),
    });
  }

  resetOrigin(containerId: ContainerId, origin: string): number {
    let removed = 0;
    for (let i = this.records.length - 1; i >= 0; i--) {
      const record = this.records[i];
      if (record?.containerId === containerId && record.origin === origin) {
        this.records.splice(i, 1);
        removed++;
      }
    }
    return removed;
  }

  resetContainer(containerId: ContainerId): number {
    let removed = 0;
    for (let i = this.records.length - 1; i >= 0; i--) {
      if (this.records[i]?.containerId === containerId) {
        this.records.splice(i, 1);
        removed++;
      }
    }
    return removed;
  }

  clearAll(): number {
    const count = this.records.length;
    this.records.splice(0, this.records.length);
    return count;
  }

  remove(containerId: ContainerId, origin: string, permission: string): boolean {
    const index = this.records.findIndex(
      (record) =>
        record.containerId === containerId &&
        record.origin === origin &&
        record.permission === permission,
    );
    if (index < 0) return false;
    this.records.splice(index, 1);
    return true;
  }

  list(containerId?: ContainerId): PermissionRecord[] {
    return this.records
      .filter((record) => !containerId || record.containerId === containerId)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  listForOrigin(containerId: ContainerId, origin: string): PermissionRecord[] {
    return this.records
      .filter((record) => record.containerId === containerId && record.origin === origin)
      .sort((a, b) => a.permission.localeCompare(b.permission));
  }
}
