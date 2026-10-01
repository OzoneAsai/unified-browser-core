import type { WebviewElement } from "../ui/webview-types";

type RequireLike = (id: string) => any;

export function resolveElectronRemote<T = any>(): T | undefined {
  const req = rendererRequire();
  if (!req) return undefined;
  try {
    return req("@electron/remote") as T;
  } catch {
    try {
      return req("electron")?.remote as T | undefined;
    } catch {
      return undefined;
    }
  }
}

export function resolveElectronRenderer<T = any>(): T | undefined {
  const req = rendererRequire();
  if (!req) return undefined;
  try {
    return req("electron") as T;
  } catch {
    return undefined;
  }
}

export function compileMainProcessModule<T = any>(
  virtualFilename: string,
  source: string,
): T | undefined {
  const remote = resolveElectronRemote<{
    require?: (id: string) => any;
  }>();
  if (!remote?.require) return undefined;
  try {
    const Module = remote.require("module");
    if (typeof Module !== "function") return undefined;
    const compiled = new Module(virtualFilename);
    compiled.filename = virtualFilename;
    compiled.paths = [];
    compiled._compile(source, virtualFilename);
    return compiled.exports as T;
  } catch {
    return undefined;
  }
}

export function resolveGuestWebContents<T = any>(webview: WebviewElement): T | undefined {
  try {
    const id = webview.getWebContentsId?.();
    if (typeof id !== "number") return undefined;
    const remote = resolveElectronRemote<{ webContents?: { fromId?: (id: number) => T } }>();
    return remote?.webContents?.fromId?.(id);
  } catch {
    // A freshly-created or already-detached <webview> has no usable guest yet.
    return undefined;
  }
}

export function resolvePartitionSession<T = any>(partition: string): T | undefined {
  const remote = resolveElectronRemote<{ session?: { fromPartition?: (partition: string) => T } }>();
  return remote?.session?.fromPartition?.(partition);
}

function rendererRequire(): RequireLike | undefined {
  return (window as unknown as { require?: RequireLike }).require;
}
