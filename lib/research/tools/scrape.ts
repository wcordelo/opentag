/** SSRF-safe URL fetch for research scrape tool. */

const BLOCKED_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "metadata.google.internal",
  "169.254.169.254",
]);

const BLOCKED_PREFIXES = ["10.", "172.16.", "172.17.", "172.18.", "172.19.",
  "172.20.", "172.21.", "172.22.", "172.23.", "172.24.", "172.25.", "172.26.",
  "172.27.", "172.28.", "172.29.", "172.30.", "172.31.", "192.168.", "fc00:", "fe80:"];

export interface ScrapeResult {
  url: string;
  title?: string;
  text: string;
  bytes: number;
}

export function isUrlAllowed(urlString: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    return false;
  }

  if (!["http:", "https:"].includes(parsed.protocol)) return false;
  if (parsed.username || parsed.password) return false;

  const host = parsed.hostname.toLowerCase();
  if (BLOCKED_HOSTS.has(host)) return false;
  if (host.endsWith(".local") || host.endsWith(".internal")) return false;

  for (const prefix of BLOCKED_PREFIXES) {
    if (host.startsWith(prefix)) return false;
  }

  return true;
}

const MAX_SCRAPE_BYTES = 512_000;
const SCRAPE_TIMEOUT_MS = 15_000;

export async function scrapeUrl(url: string): Promise<ScrapeResult> {
  if (!isUrlAllowed(url)) {
    throw new Error(`URL blocked by SSRF policy: ${url}`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SCRAPE_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "OpenTag-Research/1.0",
        Accept: "text/html,application/xhtml+xml,text/plain",
      },
      redirect: "follow",
    });

    if (!res.ok) {
      throw new Error(`Scrape failed ${res.status} for ${url}`);
    }

    const contentType = res.headers.get("content-type") ?? "";
    const buf = await res.arrayBuffer();
    const bytes = Math.min(buf.byteLength, MAX_SCRAPE_BYTES);
    const text = new TextDecoder("utf-8").decode(
      buf.slice(0, bytes),
    );

    const title = extractTitle(text, contentType);
    const plain = contentType.includes("html") ? stripHtml(text) : text;

    return { url, title, text: plain.slice(0, 50_000), bytes };
  } finally {
    clearTimeout(timer);
  }
}

function extractTitle(html: string, contentType: string): string | undefined {
  if (!contentType.includes("html")) return undefined;
  const match = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
  return match?.[1]?.trim();
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
