export function normalizeBrowserAddress(
  value: string,
  searchUrl: (query: string) => string,
): string {
  const trimmed = value.trim();
  if (!trimmed) return "browser://home";

  if (/^browser:\/\//i.test(trimmed)) {
    return "browser://" + trimmed.slice("browser://".length).toLowerCase();
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;

  const inferred = inferWebAddress(trimmed);
  return inferred ?? searchUrl(trimmed);
}

function inferWebAddress(value: string): string | undefined {
  if (/\s/.test(value) || value.includes("@")) return undefined;

  let parsed: URL;
  try {
    parsed = new URL("https://" + value);
  } catch {
    return undefined;
  }

  const hostname = parsed.hostname;
  if (!hostname) return undefined;
  if (hostname === "localhost" || isIpv4(hostname) || isBracketedIpv6(value)) {
    return "http://" + value;
  }

  const labels = hostname.split(".");
  if (labels.length < 2 || labels.some((label) => !label)) return undefined;
  const suffix = labels.at(-1) ?? "";
  if (!/^(?:[a-z]{2,}|xn--[a-z0-9-]+)$/i.test(suffix)) return undefined;
  return "https://" + value;
}

function isIpv4(hostname: string): boolean {
  const parts = hostname.split(".");
  return parts.length === 4 && parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false;
    const value = Number(part);
    return value >= 0 && value <= 255;
  });
}

function isBracketedIpv6(value: string): boolean {
  return /^\[[0-9a-f:.]+\](?::\d+)?(?:[/?#]|$)/i.test(value);
}
