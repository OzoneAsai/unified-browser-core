/** Site zoom is relative to the containing Obsidian window, as in Surfing. */
export function hostZoomFactor(doc: Document): number {
  try {
    const win = doc.defaultView as (Window & { require?: (id: string) => any }) | null;
    const value = win?.require?.("electron")?.webFrame?.getZoomFactor?.();
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 1;
  } catch {
    return 1;
  }
}
