export type InPageHistoryIntent = "back" | "forward" | "in-page";

export function classifyInPageNavigation(
  previousIndex: number | undefined,
  nextIndex: number | undefined,
  intent: InPageHistoryIntent,
): "navigation" | "residual" {
  if (intent === "back" || intent === "forward") return "navigation";
  if (typeof previousIndex !== "number" || typeof nextIndex !== "number") return "navigation";
  return previousIndex === nextIndex ? "residual" : "navigation";
}
