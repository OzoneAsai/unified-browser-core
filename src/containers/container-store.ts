import { createId, safePartitionPart } from "../core/id";
import type {
  BrowserContainer,
  ContainerId,
  SiteAssignmentBypassReason,
  SiteContainerRule,
} from "../core/model";

export interface ContainerRoutingStatus {
  hostname: string;
  origin: string;
  assignedContainerId?: ContainerId;
  bypassingAssignment: boolean;
  bypassReason?: SiteAssignmentBypassReason;
}

export class ContainerStore {
  constructor(
    private readonly containers: Record<ContainerId, BrowserContainer>,
    private readonly rules: SiteContainerRule[],
    private readonly partitionScope: string,
  ) {}

  ensureDefault(): BrowserContainer {
    if (!this.containers.default) {
      this.containers.default = {
        id: "default",
        name: "Default",
        partition: `persist:ubc-${safePartitionPart(this.partitionScope)}-default`,
        icon: "box",
        createdAt: Date.now(),
      };
    }
    return this.containers.default;
  }

  create(name: string, color?: string, icon?: string): BrowserContainer {
    const id = createId("container");
    const container: BrowserContainer = {
      id,
      name: name.trim() || "Container",
      partition: `persist:ubc-${safePartitionPart(this.partitionScope)}-${safePartitionPart(id)}`,
      color,
      icon: icon || "box",
      createdAt: Date.now(),
    };
    this.containers[id] = container;
    return container;
  }

  remove(id: ContainerId): boolean {
    if (id === "default" || !this.containers[id]) return false;
    delete this.containers[id];
    for (let i = this.rules.length - 1; i >= 0; i--) {
      if (this.rules[i]?.containerId === id) this.rules.splice(i, 1);
    }
    return true;
  }

  get(id: ContainerId | undefined): BrowserContainer {
    return (id && this.containers[id]) || this.ensureDefault();
  }

  find(id: ContainerId | undefined): BrowserContainer | undefined {
    return id ? this.containers[id] : undefined;
  }

  nameFor(id: ContainerId | undefined): string {
    if (!id) return this.ensureDefault().name;
    return this.containers[id]?.name ?? "Deleted container";
  }

  list(): BrowserContainer[] {
    this.ensureDefault();
    return Object.values(this.containers).sort((a, b) => a.createdAt - b.createdAt);
  }

  assignOrigin(originPattern: string, containerId: ContainerId): void {
    const existing = this.rules.find((rule) => rule.originPattern === originPattern);
    if (existing) {
      existing.containerId = containerId;
      return;
    }
    this.rules.push({ originPattern, containerId });
  }

  unassignOrigin(originPattern: string): boolean {
    const index = this.rules.findIndex((rule) => rule.originPattern === originPattern);
    if (index < 0) return false;
    this.rules.splice(index, 1);
    return true;
  }

  assignments(): SiteContainerRule[] {
    return [...this.rules].sort((a, b) => a.originPattern.localeCompare(b.originPattern));
  }

  assignmentForHostname(hostname: string): SiteContainerRule | undefined {
    return this.rules
      .filter((rule) => hostname === rule.originPattern || hostname.endsWith(`.${rule.originPattern}`))
      .sort((a, b) => b.originPattern.length - a.originPattern.length)[0];
  }

  assignmentForUrl(url: string): SiteContainerRule | undefined {
    try {
      return this.assignmentForHostname(new URL(url).hostname);
    } catch {
      return undefined;
    }
  }

  bypassOriginForExplicitContainer(url: string, containerId: ContainerId): string | undefined {
    try {
      const parsed = new URL(url);
      const assignment = this.assignmentForHostname(parsed.hostname);
      if (!assignment || assignment.containerId === containerId) return undefined;
      return parsed.origin;
    } catch {
      return undefined;
    }
  }

  openerBypassOriginForCommittedUrl(url: string, containerId: ContainerId): string | undefined {
    try {
      const parsed = new URL(url);
      const assignment = this.assignmentForHostname(parsed.hostname);
      return assignment && assignment.containerId !== containerId ? parsed.origin : undefined;
    } catch {
      return undefined;
    }
  }

  resolveForUrl(url: string, fallbackId: ContainerId): ContainerId {
    return this.assignmentForUrl(url)?.containerId ?? fallbackId;
  }

  routingStatus(
    url: string,
    currentContainerId: ContainerId,
    bypassOrigin?: string,
    bypassReason?: SiteAssignmentBypassReason,
  ): ContainerRoutingStatus | undefined {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
      const assignment = this.assignmentForHostname(parsed.hostname);
      const bypassingAssignment = Boolean(
        assignment &&
        assignment.containerId !== currentContainerId &&
        bypassOrigin === parsed.origin
      );
      return {
        hostname: parsed.hostname,
        origin: parsed.origin,
        assignedContainerId: assignment?.containerId,
        bypassingAssignment,
        bypassReason: bypassingAssignment ? (bypassReason ?? "explicit") : undefined,
      };
    } catch {
      return undefined;
    }
  }
}
