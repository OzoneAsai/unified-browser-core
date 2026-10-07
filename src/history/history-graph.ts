import { createId } from "../core/id";
import type { BrowserEventBus } from "../core/events";
import type {
  BrowserLeafRecord,
  ContainerId,
  HistoryGraphState,
  HistoryNode,
  HistoryNodeId,
  LeafId,
  ManualRetention,
  NavigationNode,
  ResidualNode,
} from "../core/model";

export interface NavigationInput {
  leafId: LeafId;
  containerId: ContainerId;
  url: string;
  title?: string;
  timestamp?: number;
  reason?: "navigate" | "back" | "forward" | "in-page";
  sessionEntryIndex?: number;
}

export class HistoryGraph {
  constructor(
    private readonly state: HistoryGraphState,
    private readonly events?: BrowserEventBus,
  ) {}

  beginLeaf(input: {
    leafId: LeafId;
    containerId: ContainerId;
    pinned?: boolean;
    manualRetention?: ManualRetention;
    restoredFromLeafId?: LeafId;
    url?: string;
    title?: string;
  }): BrowserLeafRecord {
    const existing = this.state.leaves[input.leafId];
    if (existing) {
      existing.closedAt = undefined;
      existing.closeReason = undefined;
      existing.lastActiveAt = Date.now();
      this.events?.emit("leaf-opened", existing);
      return existing;
    }

    const record: BrowserLeafRecord = {
      id: input.leafId,
      openedAt: Date.now(),
      containerId: input.containerId,
      pinned: input.pinned ?? false,
      manualRetention: input.manualRetention ?? "default",
      restoredFromLeafId: input.restoredFromLeafId,
      lastUrl: input.url,
      lastTitle: input.title,
      lastActiveAt: Date.now(),
    };
    this.state.leaves[input.leafId] = record;
    this.events?.emit("leaf-opened", record);
    return record;
  }

  closeLeaf(leafId: LeafId, reason: BrowserLeafRecord["closeReason"] = "user"): void {
    const leaf = this.state.leaves[leafId];
    if (!leaf) return;
    leaf.closedAt = Date.now();
    leaf.closeReason = reason;
    leaf.lastActiveAt = leaf.closedAt;
    this.events?.emit("leaf-closed", leaf);
  }

  touchLeaf(leafId: LeafId, patch: Partial<BrowserLeafRecord>): void {
    const leaf = this.state.leaves[leafId];
    if (!leaf) return;
    Object.assign(leaf, patch, { lastActiveAt: Date.now() });
  }

  updateCurrentNavigation(
    leafId: LeafId,
    patch: Partial<Pick<NavigationNode, "title" | "url" | "sessionEntryIndex">>,
  ): void {
    const current = this.getCurrent(leafId);
    if (current?.kind !== "navigation") return;
    Object.assign(current, patch);
    this.touchLeaf(leafId, {
      lastTitle: patch.title ?? current.title,
      lastUrl: patch.url ?? current.url,
    });
  }

  addNavigation(input: NavigationInput): NavigationNode {
    const now = input.timestamp ?? Date.now();
    const currentId = this.state.currentByLeaf[input.leafId];
    const current = currentId ? this.state.nodes[currentId] : undefined;

    if (input.reason === "back" || input.reason === "forward") {
      const existing = this.findAdjacentNavigation(input.leafId, currentId, input.url, input.reason);
      if (existing) {
        if (typeof input.sessionEntryIndex === "number") {
          existing.sessionEntryIndex = input.sessionEntryIndex;
        }
        this.state.currentByLeaf[input.leafId] = existing.id;
        this.touchLeaf(input.leafId, { lastUrl: existing.url, lastTitle: existing.title });
        this.events?.emit("navigation-committed", existing);
        return existing;
      }
    }

    const parentId = current?.kind === "residual" ? current.parentId : current?.id;
    const branchId = this.branchForNewNavigation(parentId);
    const node: NavigationNode = {
      id: createId("nav"),
      kind: "navigation",
      leafId: input.leafId,
      containerId: input.containerId,
      timestamp: now,
      url: input.url,
      title: input.title || input.url,
      parentId,
      branchId,
      sessionEntryIndex: input.sessionEntryIndex,
      stale: false,
      manualRetention: "default",
    };
    this.state.nodes[node.id] = node;
    if (parentId) this.state.edges.push({ from: parentId, to: node.id, kind: "navigation" });
    if (!parentId) {
      const sourceLeafId = this.state.leaves[input.leafId]?.restoredFromLeafId;
      const sourceNodeId = sourceLeafId ? this.state.currentByLeaf[sourceLeafId] : undefined;
      if (sourceNodeId && this.state.nodes[sourceNodeId]) {
        this.state.edges.push({ from: sourceNodeId, to: node.id, kind: "restore" });
      }
    }
    this.state.currentByLeaf[input.leafId] = node.id;
    this.touchLeaf(input.leafId, { lastUrl: node.url, lastTitle: node.title });
    this.events?.emit("navigation-committed", node);
    return node;
  }

  addResidual(input: {
    leafId: LeafId;
    residualKind: ResidualNode["residualKind"];
    fromUrl?: string;
    toUrl?: string;
    detail?: string;
    timestamp?: number;
  }): ResidualNode {
    const parentId = this.state.currentByLeaf[input.leafId];
    const node: ResidualNode = {
      id: createId("res"),
      kind: "residual",
      leafId: input.leafId,
      timestamp: input.timestamp ?? Date.now(),
      residualKind: input.residualKind,
      parentId,
      fromUrl: input.fromUrl,
      toUrl: input.toUrl,
      detail: input.detail,
    };
    this.state.nodes[node.id] = node;
    if (parentId) this.state.edges.push({ from: parentId, to: node.id, kind: "residual" });
    return node;
  }

  deleteNode(nodeId: HistoryNodeId): boolean {
    const node = this.state.nodes[nodeId];
    if (!node || node.kind === "tombstone") return false;
    if (node.kind === "navigation") {
      for (const child of this.childrenOf(nodeId)) {
        if (child.kind === "residual") this.removeResidual(child.id);
      }
    }
    this.state.nodes[nodeId] = {
      id: nodeId,
      kind: "tombstone",
      leafId: node.leafId,
      timestamp: node.timestamp,
      deletedAt: Date.now(),
    };
    return true;
  }

  deleteLeafHistory(leafId: LeafId): number {
    let changed = 0;
    for (const node of this.nodesForLeaf(leafId)) {
      if (node.kind !== "tombstone" && this.deleteNode(node.id)) changed++;
    }
    const leaf = this.state.leaves[leafId];
    if (leaf) {
      leaf.lastUrl = undefined;
      leaf.lastTitle = undefined;
    }
    return changed;
  }

  deleteBranch(branchId: string): number {
    const navigationIds = new Set(
      Object.values(this.state.nodes)
        .filter((node): node is NavigationNode => node.kind === "navigation" && node.branchId === branchId)
        .map((node) => node.id),
    );
    let changed = 0;
    for (const nodeId of navigationIds) {
      if (this.deleteNode(nodeId)) changed++;
    }
    return changed;
  }

  navigationNodesForBranch(branchId: string): NavigationNode[] {
    return Object.values(this.state.nodes)
      .filter((node): node is NavigationNode => node.kind === "navigation" && node.branchId === branchId)
      .sort((a, b) => a.timestamp - b.timestamp);
  }

  latestNavigationForLeaf(leafId: LeafId): NavigationNode | undefined {
    return this.nodesForLeaf(leafId)
      .filter((node): node is NavigationNode => node.kind === "navigation")
      .at(-1);
  }

  forgetLeafRecord(leafId: LeafId): void {
    delete this.state.leaves[leafId];
    delete this.state.currentByLeaf[leafId];
  }

  removeTombstone(nodeId: HistoryNodeId): { ok: boolean; reason?: string } {
    const check = this.canRemoveTombstone(nodeId);
    if (!check.ok) return check;
    const incoming = this.state.edges.filter((edge) => edge.to === nodeId);
    const outgoing = this.state.edges.filter((edge) => edge.from === nodeId);

    this.state.edges = this.state.edges.filter((edge) => edge.from !== nodeId && edge.to !== nodeId);
    if (incoming[0] && outgoing[0]) {
      const kind = incoming[0].kind === "restore" || outgoing[0].kind === "restore" ? "restore" : "navigation";
      this.state.edges.push({ from: incoming[0].from, to: outgoing[0].to, kind });
    }
    delete this.state.nodes[nodeId];
    return { ok: true };
  }

  canRemoveTombstone(nodeId: HistoryNodeId): { ok: boolean; reason?: string } {
    const node = this.state.nodes[nodeId];
    if (!node || node.kind !== "tombstone") {
      return { ok: false, reason: "This entry is no longer a deleted entry marker." };
    }
    const incoming = this.state.edges.filter((edge) => edge.to === nodeId);
    const outgoing = this.state.edges.filter((edge) => edge.from === nodeId);
    if (incoming.length > 1 || outgoing.length > 1) {
      return {
        ok: false,
        reason: "This deleted entry marker connects multiple history paths, so removing it could change the remaining history.",
      };
    }
    return { ok: true };
  }

  setCurrent(leafId: LeafId, nodeId: HistoryNodeId): void {
    const node = this.state.nodes[nodeId];
    if (node?.leafId === leafId) this.state.currentByLeaf[leafId] = nodeId;
  }

  getCurrent(leafId: LeafId): HistoryNode | undefined {
    const id = this.state.currentByLeaf[leafId];
    return id ? this.state.nodes[id] : undefined;
  }

  currentBranchForLeaf(leafId: LeafId): string | undefined {
    const current = this.getCurrent(leafId);
    if (current?.kind === "navigation") return current.branchId;
    if (current?.kind === "residual" && current.parentId) {
      const parent = this.state.nodes[current.parentId];
      return parent?.kind === "navigation" ? parent.branchId : undefined;
    }
    return undefined;
  }

  recentlyClosed(limit = 20): BrowserLeafRecord[] {
    return Object.values(this.state.leaves)
      .filter((leaf) =>
        typeof leaf.closedAt === "number" &&
        leaf.closeReason !== "shutdown" &&
        leaf.closeReason !== "replaced"
      )
      .sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0))
      .slice(0, limit);
  }

  clearAll(): { nodes: number; leaves: number } {
    const nodes = Object.keys(this.state.nodes).length;
    const leaves = Object.keys(this.state.leaves).length;
    this.state.nodes = {};
    this.state.edges = [];
    this.state.currentByLeaf = {};
    this.state.leaves = {};
    return { nodes, leaves };
  }

  sweep(
    settings: { historyRetentionDays: number; historyMaxNodes: number },
    now = Date.now(),
  ): number {
    const candidates = Object.values(this.state.leaves)
      .filter((leaf) => typeof leaf.closedAt === "number")
      .filter((leaf) => leaf.closeReason !== "shutdown")
      .filter((leaf) => !this.isProtectedLeaf(leaf.id))
      .sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0));
    let removed = 0;

    if (settings.historyRetentionDays > 0) {
      const cutoff = now - settings.historyRetentionDays * 24 * 60 * 60 * 1000;
      for (const leaf of candidates) {
        if ((leaf.closedAt ?? Infinity) >= cutoff) continue;
        removed += this.removeLeafPermanently(leaf.id);
      }
    }

    const maxNodes = Math.floor(settings.historyMaxNodes);
    if (maxNodes > 0 && Object.keys(this.state.nodes).length > maxNodes) {
      for (const leaf of candidates) {
        if (!this.state.leaves[leaf.id]) continue;
        removed += this.removeLeafPermanently(leaf.id);
        if (Object.keys(this.state.nodes).length <= maxNodes) break;
      }
    }
    return removed;
  }

  nodesForLeaf(leafId: LeafId): HistoryNode[] {
    return Object.values(this.state.nodes)
      .filter((node) => node.leafId === leafId)
      .sort((a, b) => a.timestamp - b.timestamp);
  }

  allNodes(): HistoryNode[] {
    return Object.values(this.state.nodes).sort((a, b) => b.timestamp - a.timestamp);
  }

  childrenOf(nodeId: HistoryNodeId): HistoryNode[] {
    return this.state.edges
      .filter((edge) => edge.from === nodeId)
      .map((edge) => this.state.nodes[edge.to])
      .filter((node): node is HistoryNode => Boolean(node));
  }

  residualsOf(nodeId: HistoryNodeId): ResidualNode[] {
    return this.childrenOf(nodeId).filter((node): node is ResidualNode => node.kind === "residual");
  }

  edgeSummary(nodeId: HistoryNodeId): { incoming: number; outgoing: number } {
    return {
      incoming: this.state.edges.filter((edge) => edge.to === nodeId).length,
      outgoing: this.state.edges.filter((edge) => edge.from === nodeId).length,
    };
  }

  private branchForNewNavigation(parentId?: HistoryNodeId): string {
    if (!parentId) return createId("branch");
    const parent = this.state.nodes[parentId];
    const existingChildren = this.state.edges.filter((edge) => edge.from === parentId && edge.kind === "navigation");
    if (parent?.kind === "navigation" && existingChildren.length === 0) return parent.branchId;
    return createId("branch");
  }

  private findAdjacentNavigation(
    leafId: LeafId,
    currentId: HistoryNodeId | undefined,
    url: string,
    direction: "back" | "forward",
  ): NavigationNode | undefined {
    if (!currentId) return undefined;
    if (direction === "back") {
      const incoming = this.state.edges.find((edge) => edge.to === currentId && edge.kind === "navigation");
      const node = incoming ? this.state.nodes[incoming.from] : undefined;
      return node?.kind === "navigation" && node.leafId === leafId && node.url === url ? node : undefined;
    }
    const outgoing = this.state.edges.find((edge) => edge.from === currentId && edge.kind === "navigation");
    if (outgoing) {
      const first = this.state.nodes[outgoing.to];
      if (first?.kind === "navigation" && first.leafId === leafId && first.url === url) return first;
    }
    for (const edge of this.state.edges) {
      if (edge.from !== currentId || edge.kind !== "navigation") continue;
      const node = this.state.nodes[edge.to];
      if (node?.kind === "navigation" && node.leafId === leafId && node.url === url) return node;
    }
    return undefined;
  }

  private removeResidual(nodeId: HistoryNodeId): void {
    const node = this.state.nodes[nodeId];
    if (!node || node.kind !== "residual") return;
    delete this.state.nodes[nodeId];
    this.state.edges = this.state.edges.filter((edge) => edge.from !== nodeId && edge.to !== nodeId);
  }

  private isProtectedLeaf(leafId: LeafId): boolean {
    const leaf = this.state.leaves[leafId];
    if (!leaf) return false;
    if (leaf.pinned || leaf.manualRetention === "preserve") return true;
    return this.nodesForLeaf(leafId).some(
      (node) => node.kind === "navigation" && node.manualRetention === "preserve",
    );
  }

  private removeLeafPermanently(leafId: LeafId): number {
    const nodeIds = new Set(this.nodesForLeaf(leafId).map((node) => node.id));
    const count = nodeIds.size;
    for (const nodeId of nodeIds) delete this.state.nodes[nodeId];
    this.state.edges = this.state.edges.filter(
      (edge) => !nodeIds.has(edge.from) && !nodeIds.has(edge.to),
    );
    delete this.state.currentByLeaf[leafId];
    delete this.state.leaves[leafId];
    return count;
  }
}
