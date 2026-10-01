import { createId } from "./id";
import type {
  BrowserCoreState,
  BrowserSettings,
  FormRecoveryField,
  FormRecoveryPolicy,
  FormRecoverySnapshot,
  ContainerId,
} from "./model";

export class FormRecoveryStore {
  constructor(private readonly state: BrowserCoreState) {
    this.migrateLegacyScope();
  }

  put(
    containerId: ContainerId,
    url: string,
    fields: FormRecoveryField[],
    settings: Pick<BrowserSettings, "formRecoveryMaxSnapshotsPerUrl" | "formRecoveryMaxUrls">,
  ): FormRecoverySnapshot | undefined {
    const allowed = this.filterAllowed(containerId, url, fields);
    if (!allowed.length) return undefined;
    const key = this.key(containerId, url);
    const snapshot: FormRecoverySnapshot = {
      id: createId("form"),
      containerId,
      url,
      capturedAt: Date.now(),
      fields: allowed,
    };
    const list = this.state.formRecovery[key] ?? [];
    const newest = list[0];
    if (newest && sameFields(newest.fields, allowed)) {
      list[0] = snapshot;
      this.state.formRecovery[key] = list;
      return snapshot;
    }
    list.unshift(snapshot);
    this.state.formRecovery[key] = list.slice(0, Math.max(1, settings.formRecoveryMaxSnapshotsPerUrl));
    this.trimUrlCount(Math.max(1, settings.formRecoveryMaxUrls));
    return snapshot;
  }

  latest(containerId: ContainerId, url: string): FormRecoverySnapshot | undefined {
    return this.state.formRecovery[this.key(containerId, url)]?.[0];
  }

  has(containerId: ContainerId, url: string): boolean {
    return this.recoveryFields(containerId, url).length > 0;
  }

  hasForDocument(containerId: ContainerId, url: string): boolean {
    return this.recoveryFieldsForDocument(containerId, url).length > 0;
  }

  recoveryFields(containerId: ContainerId, url: string): FormRecoveryField[] {
    const snapshots = this.state.formRecovery[this.key(containerId, url)] ?? [];
    return this.mergeRecoveryFields(containerId, url, snapshots);
  }

  recoveryFieldsForDocument(containerId: ContainerId, url: string): FormRecoveryField[] {
    const exact = this.state.formRecovery[this.key(containerId, url)] ?? [];
    if (exact.length) return this.mergeRecoveryFields(containerId, url, exact);

    const scope = this.documentScope(url);
    if (!scope) return [];
    const related = Object.values(this.state.formRecovery)
      .flat()
      .filter((snapshot) =>
        snapshot.containerId === containerId
        && this.documentScope(snapshot.url) === scope,
      )
      .sort((a, b) => b.capturedAt - a.capturedAt);
    return this.mergeRecoveryFields(containerId, url, related);
  }

  private mergeRecoveryFields(
    containerId: ContainerId,
    url: string,
    snapshots: FormRecoverySnapshot[],
  ): FormRecoveryField[] {
    const merged = new Map<string, FormRecoveryField>();
    for (const snapshot of snapshots) {
      for (const field of snapshot.fields) {
        const fingerprint = fieldKey(field);
        if (!merged.has(fingerprint)) merged.set(fingerprint, field);
      }
    }
    return this.filterAllowed(containerId, url, [...merged.values()]);
  }

  isEnabledForUrl(containerId: ContainerId, url: string): boolean {
    return this.policyForUrl(containerId, url)?.disabled === false;
  }

  disableSite(containerId: ContainerId, url: string, clearStored = true): boolean {
    const origin = this.origin(url);
    if (!origin) return false;
    const policy = this.ensurePolicy(containerId, origin);
    policy.disabled = true;
    policy.updatedAt = Date.now();
    if (clearStored) this.clearForOrigin(containerId, origin);
    return true;
  }

  enableSite(containerId: ContainerId, url: string): boolean {
    const origin = this.origin(url);
    if (!origin) return false;
    const policy = this.ensurePolicy(containerId, origin);
    policy.disabled = false;
    policy.updatedAt = Date.now();
    return true;
  }

  excludeField(containerId: ContainerId, url: string, field: FormRecoveryField): boolean {
    const origin = this.origin(url);
    if (!origin) return false;
    const policy = this.ensurePolicy(containerId, origin);
    const key = fieldKey(field);
    if (!policy.excludedFieldKeys.includes(key)) policy.excludedFieldKeys.push(key);
    policy.updatedAt = Date.now();
    this.removeFieldFromStored(containerId, origin, key);
    return true;
  }

  resetPolicy(containerId: ContainerId, origin: string): boolean {
    const key = this.policyKey(containerId, origin);
    if (!this.state.formRecoveryPolicies[key]) return false;
    delete this.state.formRecoveryPolicies[key];
    this.clearForOrigin(containerId, origin);
    return true;
  }

  policies(): FormRecoveryPolicy[] {
    return Object.values(this.state.formRecoveryPolicies).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  clearForUrl(containerId: ContainerId, url: string): void {
    delete this.state.formRecovery[this.key(containerId, url)];
  }

  clearForSite(containerId: ContainerId, url: string): number {
    const origin = this.origin(url);
    return origin ? this.clearForOrigin(containerId, origin) : 0;
  }

  clearAll(): number {
    const count = Object.keys(this.state.formRecovery).length;
    this.state.formRecovery = {};
    return count;
  }

  clearContainer(containerId: ContainerId): { snapshots: number; policies: number } {
    let snapshots = 0;
    for (const [key, entries] of Object.entries(this.state.formRecovery)) {
      if (!entries.some((entry) => entry.containerId === containerId)) continue;
      delete this.state.formRecovery[key];
      snapshots++;
    }
    let policies = 0;
    for (const [key, policy] of Object.entries(this.state.formRecoveryPolicies)) {
      if (policy.containerId !== containerId) continue;
      delete this.state.formRecoveryPolicies[key];
      policies++;
    }
    return { snapshots, policies };
  }

  sweep(
    settings: Pick<
      BrowserSettings,
      "formRecoveryRetentionDays" | "formRecoveryMaxSnapshotsPerUrl" | "formRecoveryMaxUrls"
    >,
    now = Date.now(),
  ): boolean {
    let changed = false;
    const maxAgeMs = settings.formRecoveryRetentionDays > 0
      ? settings.formRecoveryRetentionDays * 24 * 60 * 60 * 1000
      : Infinity;
    const perUrl = Math.max(1, settings.formRecoveryMaxSnapshotsPerUrl);

    for (const [key, snapshots] of Object.entries(this.state.formRecovery)) {
      const approved = snapshots.some((snapshot) =>
        this.isEnabledForUrl(snapshot.containerId, snapshot.url),
      );
      if (!approved) {
        delete this.state.formRecovery[key];
        changed = true;
        continue;
      }
      const next = snapshots
        .filter((snapshot) => now - snapshot.capturedAt <= maxAgeMs)
        .map((snapshot) => {
          const fields = this.filterAllowed(snapshot.containerId, snapshot.url, snapshot.fields);
          if (fields.length !== snapshot.fields.length) changed = true;
          return { ...snapshot, fields };
        })
        .filter((snapshot) => snapshot.fields.length > 0)
        .slice(0, perUrl);
      if (next.length !== snapshots.length) changed = true;
      if (next.length) this.state.formRecovery[key] = next;
      else delete this.state.formRecovery[key];
    }

    if (this.trimUrlCount(Math.max(1, settings.formRecoveryMaxUrls))) changed = true;
    return changed;
  }

  private filterAllowed(
    containerId: ContainerId,
    url: string,
    fields: FormRecoveryField[],
  ): FormRecoveryField[] {
    const policy = this.policyForUrl(containerId, url);
    if (!policy || policy.disabled) return [];
    const safeFields = fields.filter((field) => !isSensitiveField(field));
    if (!policy.excludedFieldKeys.length) return safeFields;
    const excluded = new Set(policy.excludedFieldKeys);
    return safeFields.filter((field) => !excluded.has(fieldKey(field)));
  }

  private policyForUrl(containerId: ContainerId, url: string): FormRecoveryPolicy | undefined {
    const origin = this.origin(url);
    return origin ? this.state.formRecoveryPolicies[this.policyKey(containerId, origin)] : undefined;
  }

  private ensurePolicy(containerId: ContainerId, origin: string): FormRecoveryPolicy {
    const key = this.policyKey(containerId, origin);
    return this.state.formRecoveryPolicies[key] ??= {
      containerId,
      origin,
      disabled: false,
      excludedFieldKeys: [],
      updatedAt: Date.now(),
    };
  }

  private clearForOrigin(containerId: ContainerId, origin: string): number {
    let removed = 0;
    for (const [key, snapshots] of Object.entries(this.state.formRecovery)) {
      if (!snapshots.some(
        (snapshot) => snapshot.containerId === containerId && this.origin(snapshot.url) === origin,
      )) continue;
      delete this.state.formRecovery[key];
      removed++;
    }
    return removed;
  }

  private removeFieldFromStored(containerId: ContainerId, origin: string, excludedKey: string): void {
    for (const snapshots of Object.values(this.state.formRecovery)) {
      for (const snapshot of snapshots) {
        if (snapshot.containerId !== containerId || this.origin(snapshot.url) !== origin) continue;
        snapshot.fields = snapshot.fields.filter((field) => fieldKey(field) !== excludedKey);
      }
    }
  }

  private origin(url: string): string | undefined {
    try {
      const parsed = new URL(url);
      return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : undefined;
    } catch {
      return undefined;
    }
  }

  private documentScope(url: string): string | undefined {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
      return parsed.origin + parsed.pathname;
    } catch {
      return undefined;
    }
  }

  private key(containerId: ContainerId, url: string): string {
    try {
      const parsed = new URL(url);
      parsed.hash = "";
      return containerId + "\u001e" + parsed.toString();
    } catch {
      return containerId + "\u001e" + url;
    }
  }

  private policyKey(containerId: ContainerId, origin: string): string {
    return containerId + "\u001e" + origin;
  }

  private migrateLegacyScope(): void {
    const migratedRecovery: Record<string, FormRecoverySnapshot[]> = {};
    for (const snapshots of Object.values(this.state.formRecovery)) {
      for (const legacySnapshot of snapshots) {
        const snapshot = legacySnapshot as FormRecoverySnapshot & { containerId?: ContainerId };
        const containerId = snapshot.containerId ?? "default";
        const normalized: FormRecoverySnapshot = { ...snapshot, containerId };
        const key = this.key(containerId, normalized.url);
        (migratedRecovery[key] ??= []).push(normalized);
      }
    }
    for (const snapshots of Object.values(migratedRecovery)) {
      snapshots.sort((a, b) => b.capturedAt - a.capturedAt);
    }
    this.state.formRecovery = migratedRecovery;

    const migratedPolicies: Record<string, FormRecoveryPolicy> = {};
    for (const legacyPolicy of Object.values(this.state.formRecoveryPolicies)) {
      const policy = legacyPolicy as FormRecoveryPolicy & { containerId?: ContainerId };
      const containerId = policy.containerId ?? "default";
      const normalized: FormRecoveryPolicy = { ...policy, containerId };
      migratedPolicies[this.policyKey(containerId, normalized.origin)] = normalized;
    }
    this.state.formRecoveryPolicies = migratedPolicies;
  }

  private trimUrlCount(maxUrls: number): boolean {
    const entries = Object.entries(this.state.formRecovery);
    if (entries.length <= maxUrls) return false;
    entries.sort((a, b) => newestTimestamp(b[1]) - newestTimestamp(a[1]));
    for (const [key] of entries.slice(maxUrls)) delete this.state.formRecovery[key];
    return true;
  }
}

function sameFields(a: FormRecoveryField[], b: FormRecoveryField[]): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

function fieldKey(field: FormRecoveryField): string {
  const choiceValue = field.type === "radio" || field.type === "checkbox" ? field.value ?? "" : "";
  return [
    field.id ?? "",
    field.name ?? "",
    field.type,
    field.label ?? "",
    field.autocomplete ?? "",
    field.ariaLabel ?? "",
    field.placeholder ?? "",
    field.nearbyText ?? "",
    choiceValue,
  ].join("\u001f");
}

function newestTimestamp(snapshots: FormRecoverySnapshot[]): number {
  return snapshots.reduce((latest, snapshot) => Math.max(latest, snapshot.capturedAt), 0);
}

function isSensitiveField(field: FormRecoveryField): boolean {
  const type = field.type.toLowerCase();
  if (type === "password" || type === "file" || type === "hidden") return true;
  const haystack = [
    field.name,
    field.id,
    field.label,
    field.autocomplete,
    field.ariaLabel,
    field.placeholder,
    field.nearbyText,
  ].filter(Boolean).join(" ").toLowerCase();
  return /(?:password|passcode|one[- ]?time|otp|webauthn|cc-|credit[- ]?card|card[- ]?(?:number|no)|cvc|cvv|security[- ]?code)/i.test(haystack);
}
