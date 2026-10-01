export class SiteZoomStore {
  constructor(
    private readonly factors: Record<string, number>,
    private readonly defaultFactor: () => number = () => 1,
  ) {}

  factorForUrl(url: string): number {
    const origin = this.origin(url);
    const fallback = clampZoom(this.defaultFactor());
    return origin ? this.factors[origin] ?? fallback : fallback;
  }

  setForUrl(url: string, factor: number): number {
    const origin = this.origin(url);
    const next = clampZoom(factor);
    if (!origin) return next;
    if (Math.abs(next - clampZoom(this.defaultFactor())) < 0.001) delete this.factors[origin];
    else this.factors[origin] = next;
    return next;
  }

  adjust(url: string, delta: number): number {
    return this.setForUrl(url, this.factorForUrl(url) + delta);
  }

  reset(url: string): void {
    const origin = this.origin(url);
    if (origin) delete this.factors[origin];
  }

  entries(): Array<{ origin: string; factor: number }> {
    return Object.entries(this.factors)
      .map(([origin, factor]) => ({ origin, factor }))
      .sort((a, b) => a.origin.localeCompare(b.origin));
  }

  private origin(url: string): string | undefined {
    try {
      const parsed = new URL(url);
      return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : undefined;
    } catch {
      return undefined;
    }
  }
}

function clampZoom(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.round(Math.min(5, Math.max(0.25, value)) * 100) / 100;
}
