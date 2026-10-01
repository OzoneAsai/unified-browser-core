import type { ContainerId, PermissionDecision } from "../core/model";
import type { PermissionStore } from "../core/permission-store";
import type { WebviewElement } from "../ui/webview-types";
import { resolveGuestWebContents } from "./electron-compat";

type PermissionRequestDetails = {
  requestingUrl?: string;
};

type SessionLike = {
  setPermissionCheckHandler?: (
    handler:
      | ((
          webContents: unknown,
          permission: string,
          requestingOrigin: string,
          details?: unknown,
        ) => boolean)
      | null,
  ) => void;
  setPermissionRequestHandler?: (
    handler:
      | ((
          webContents: { getURL?: () => string } | null,
          permission: string,
          callback: (granted: boolean) => void,
          details?: PermissionRequestDetails,
        ) => void)
      | null,
  ) => void;
};

type WebContentsLike = {
  session?: SessionLike;
};

export class ElectronPermissionAdapter {
  private readonly boundSessions = new Map<ContainerId, SessionLike>();

  bind(
    webview: WebviewElement,
    containerId: ContainerId,
    store: PermissionStore,
    prompt: (origin: string, permission: string) => Promise<PermissionDecision>,
    onChanged: () => void,
  ): boolean {
    if (this.boundSessions.has(containerId)) return true;
    const session = this.resolve(webview)?.session;
    if (!session?.setPermissionCheckHandler || !session.setPermissionRequestHandler) return false;

    session.setPermissionCheckHandler((_webContents, permission, requestingOrigin) => {
      const origin = normalizeOrigin(requestingOrigin);
      if (!origin) return false;
      return store.decision(containerId, origin, permission) === "allow";
    });

    session.setPermissionRequestHandler((webContents, permission, callback, details) => {
      const origin = normalizeOrigin(details?.requestingUrl || webContents?.getURL?.() || "");
      if (!origin) {
        callback(false);
        return;
      }
      const remembered = store.decision(containerId, origin, permission);
      if (remembered !== "ask") {
        callback(remembered === "allow");
        return;
      }
      void prompt(origin, permission).then((decision) => {
        if (decision !== "ask") {
          store.set(containerId, origin, permission, decision);
          onChanged();
        }
        callback(decision === "allow");
      });
    });

    this.boundSessions.set(containerId, session);
    return true;
  }

  release(containerId: ContainerId): void {
    const session = this.boundSessions.get(containerId);
    if (!session) return;
    session.setPermissionCheckHandler?.(null);
    session.setPermissionRequestHandler?.(null);
    this.boundSessions.delete(containerId);
  }

  dispose(): void {
    for (const containerId of [...this.boundSessions.keys()]) this.release(containerId);
  }

  boundSessionCount(): number {
    return this.boundSessions.size;
  }

  private resolve(webview: WebviewElement): WebContentsLike | undefined {
    return resolveGuestWebContents<WebContentsLike>(webview);
  }
}

function normalizeOrigin(value: string): string | undefined {
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}
