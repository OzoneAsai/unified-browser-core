/** Obsidian exposes WorkspaceLeaf.detach(), but no asynchronous before-detach
 * lifecycle event. Restrict this compatibility bridge to one browser leaf;
 * restore its original method as soon as the view is closed or unloaded.
 * Never hook WorkspaceLeaf.prototype or intercept other plugins' views. */
export interface DetachableLeaf {
  detach(): void;
}

export function gateLeafDetach(
  leaf: DetachableLeaf,
  prepare: () => Promise<void>,
  reportFailure: (error: unknown) => void = console.warn,
): () => void {
  const original = leaf.detach;
  const originalDescriptor = Object.getOwnPropertyDescriptor(leaf, "detach");
  let started = false;
  let disposed = false;
  const restore = () => {
    if (leaf.detach !== guarded) return;
    if (originalDescriptor) Object.defineProperty(leaf, "detach", originalDescriptor);
    else delete (leaf as Partial<DetachableLeaf>).detach;
  };
  const guarded = function(this: DetachableLeaf): void {
    if (started) return;
    started = true;
    void Promise.resolve()
      .then(prepare)
      .catch(error => {
        try { reportFailure(error); } catch { /* Closure must not be blocked by logging. */ }
      })
      .then(() => {
        if (disposed) return; // View was replaced while cleanup was pending.
        restore();
        original.call(leaf);
      });
  };
  leaf.detach = guarded;
  return () => {
    disposed = true;
    restore();
  };
}
