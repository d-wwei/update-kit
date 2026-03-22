import type { UpdateManifest } from "./types.js";
import { renderTemplate, sleep } from "./utils.js";

export async function githubJson<T>(
  url: string,
  manifest: UpdateManifest,
  fetchImpl: typeof fetch
): Promise<T> {
  const response = await githubRequest(url, manifest, fetchImpl);
  return await response.json() as T;
}

export async function githubPaginated<T>(
  url: string,
  manifest: UpdateManifest,
  fetchImpl: typeof fetch
): Promise<T[]> {
  const output: T[] = [];
  let nextUrl: string | undefined = withPerPage(url, manifest.github?.perPage ?? 100);
  let page = 0;
  const maxPages = manifest.github?.maxPages ?? 5;

  while (nextUrl && page < maxPages) {
    const response = await githubRequest(nextUrl, manifest, fetchImpl);
    const json = await response.json() as T[];
    output.push(...json);
    nextUrl = parseNextLink(response.headers.get("link"));
    page += 1;
  }

  return output;
}

export async function githubRequest(
  url: string,
  manifest: UpdateManifest,
  fetchImpl: typeof fetch,
  attempt = 0
): Promise<Response> {
  const response = await fetchImpl(url, {
    headers: buildGithubHeaders(manifest)
  });

  if (response.ok) return response;

  if (shouldRetryRateLimit(response) && attempt < (manifest.github?.rateLimitRetries ?? 2)) {
    const waitMs = getRateLimitWaitMs(response, manifest);
    await sleep(waitMs);
    return githubRequest(url, manifest, fetchImpl, attempt + 1);
  }

  throw new Error(`GitHub request failed: ${response.status}`);
}

export function buildGithubHeaders(manifest: UpdateManifest): HeadersInit {
  const token = manifest.github?.token ?? (manifest.github?.tokenEnv ? process.env[manifest.github.tokenEnv] : undefined);
  const headers: Record<string, string> = {
    "Accept": "application/vnd.github+json",
    "User-Agent": "update-kit"
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

export function apiBaseUrl(manifest: UpdateManifest): string {
  return renderTemplate(manifest.github?.apiBaseUrl ?? "https://api.github.com", {});
}

function withPerPage(url: string, perPage: number): string {
  const next = new URL(url);
  if (!next.searchParams.has("per_page")) {
    next.searchParams.set("per_page", String(perPage));
  }
  return next.toString();
}

function parseNextLink(linkHeader: string | null): string | undefined {
  if (!linkHeader) return undefined;
  const entries = linkHeader.split(",").map((entry) => entry.trim());
  for (const entry of entries) {
    const match = entry.match(/<([^>]+)>;\s*rel="([^"]+)"/);
    if (match?.[2] === "next") return match[1];
  }
  return undefined;
}

function shouldRetryRateLimit(response: Response): boolean {
  return response.status === 429 ||
    response.headers.get("x-ratelimit-remaining") === "0" ||
    response.headers.has("retry-after");
}

function getRateLimitWaitMs(response: Response, manifest: UpdateManifest): number {
  const retryAfter = Number(response.headers.get("retry-after") ?? "0");
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(retryAfter * 1000, manifest.github?.maxRateLimitWaitMs ?? 5000);
  }

  const resetAt = Number(response.headers.get("x-ratelimit-reset") ?? "0");
  if (Number.isFinite(resetAt) && resetAt > 0) {
    const waitMs = Math.max(0, resetAt * 1000 - Date.now());
    return Math.min(waitMs, manifest.github?.maxRateLimitWaitMs ?? 5000);
  }

  return Math.min(1000, manifest.github?.maxRateLimitWaitMs ?? 5000);
}
