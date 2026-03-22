import { readFile } from "node:fs/promises";

import type {
  ReleaseChannel,
  UpdateCandidate,
  UpdateHostContext,
  UpdateManifest,
  UpdateSummary,
  VersionSource
} from "./types.js";
import { apiBaseUrl, githubJson, githubPaginated } from "./github.js";
import {
  compareVersions,
  getRiskLevel,
  normalizeVersion,
  redactText,
  splitRepo,
  takeNonEmptyLines
} from "./utils.js";

type GithubRelease = {
  tag_name: string;
  html_url?: string;
  body?: string;
  draft?: boolean;
  prerelease?: boolean;
  published_at?: string;
};

type GithubTag = {
  name: string;
};

type GithubCompare = {
  html_url?: string;
  commits?: Array<{ commit?: { message?: string } }>;
};

export async function readVersionFromSource(cwd: string, source: VersionSource): Promise<string> {
  if (source.type === "literal" && source.value) return normalizeVersion(source.value);
  if (!source.path) throw new Error(`Version source ${source.type} requires path.`);
  const raw = await readFile(source.path, "utf8");

  if (source.type === "package.json") {
    const parsed = JSON.parse(raw) as { version?: string };
    if (!parsed.version) throw new Error("package.json missing version.");
    return normalizeVersion(parsed.version);
  }

  if (source.type === "pyproject.toml") {
    const match = raw.match(/^version\s*=\s*["']([^"']+)["']/m);
    if (!match) throw new Error("pyproject.toml missing version.");
    return normalizeVersion(match[1]!);
  }

  if (source.type === "file") {
    if (source.regex) {
      const match = raw.match(new RegExp(source.regex, "m"));
      if (!match?.[1]) throw new Error(`Could not match regex ${source.regex}.`);
      return normalizeVersion(match[1]);
    }
    if (source.key) {
      const pattern = new RegExp(`${escapeRegExp(source.key)}\\s*[:=]\\s*["']?([^"'\\n]+)`, "m");
      const match = raw.match(pattern);
      if (!match?.[1]) throw new Error(`Could not find key ${source.key}.`);
      return normalizeVersion(match[1]);
    }
    return normalizeVersion(raw.trim());
  }

  throw new Error(`Unsupported version source ${source.type}.`);
}

export async function detectCurrentVersion(
  host: UpdateHostContext,
  manifest: UpdateManifest
): Promise<string> {
  return normalizeVersion(host.currentVersion ?? await readVersionFromSource(host.cwd, manifest.currentVersionSource));
}

export async function detectLocalCandidateVersion(
  host: UpdateHostContext,
  manifest: UpdateManifest
): Promise<string | undefined> {
  if (!manifest.candidateVersionSource) return undefined;
  return readVersionFromSource(host.cwd, manifest.candidateVersionSource).catch(() => undefined);
}

export async function detectUpdateCandidate(
  host: UpdateHostContext,
  manifest: UpdateManifest,
  fetchImpl: typeof fetch
): Promise<{ candidate?: UpdateCandidate; summary: UpdateSummary }> {
  const currentVersion = await detectCurrentVersion(host, manifest);
  const now = new Date().toISOString();
  const latest = manifest.releaseChannel === "releases"
    ? await fetchLatestReleaseCandidate(manifest.repo, manifest, fetchImpl)
    : await fetchLatestTagCandidate(manifest.repo, manifest, fetchImpl);

  if (!latest) {
    return {
      summary: {
        currentVersion,
        latestVersion: currentVersion,
        hasUpdate: false,
        ignored: false,
        checkedAt: now,
        highlights: [],
        message: `${host.appName} is up to date at ${currentVersion}.`,
        riskLevel: "none"
      }
    };
  }

  const latestVersion = normalizeVersion(latest.ref);
  const hasUpdate = compareVersions(latestVersion, currentVersion) > 0;
  const riskLevel = getRiskLevel(currentVersion, latestVersion);
  const highlights = latest.highlights;

  const summary: UpdateSummary = {
    currentVersion,
    latestVersion: hasUpdate ? latestVersion : currentVersion,
    hasUpdate,
    ignored: false,
    checkedAt: now,
    releaseUrl: latest.releaseUrl,
    compareUrl: latest.compareUrl,
    highlights,
    message: hasUpdate
      ? `Update available for ${host.appName}: ${currentVersion} -> ${latestVersion}`
      : `${host.appName} is up to date at ${currentVersion}.`,
    riskLevel
  };

  if (!hasUpdate) return { summary };

  return {
    summary,
    candidate: {
      version: latestVersion,
      ref: latest.ref,
      source: manifest.releaseChannel,
      releaseUrl: latest.releaseUrl,
      compareUrl: latest.compareUrl,
      publishedAt: latest.publishedAt,
      riskLevel,
      summary
    }
  };
}

async function fetchLatestReleaseCandidate(
  repo: string,
  manifest: UpdateManifest,
  fetchImpl: typeof fetch
): Promise<{
  ref: string;
  releaseUrl?: string;
  compareUrl?: string;
  publishedAt?: string;
  highlights: string[];
} | undefined> {
  const releases = await githubPaginated<GithubRelease>(
    `${apiBaseUrl(manifest)}/repos/${repo}/releases`,
    manifest,
    fetchImpl
  );
  const candidates = releases
    .filter((release) => !release.draft)
    .filter((release) => manifest.github?.includePrerelease ? true : !release.prerelease)
    .sort((left, right) => compareVersions(left.tag_name, right.tag_name) * -1);

  const latest = candidates[0];
  if (!latest) return undefined;

  return {
    ref: latest.tag_name,
    releaseUrl: latest.html_url,
    compareUrl: latest.html_url,
    publishedAt: latest.published_at,
    highlights: takeNonEmptyLines(redactText(latest.body ?? "", manifest.privacyRules), 5)
  };
}

async function fetchLatestTagCandidate(
  repo: string,
  manifest: UpdateManifest,
  fetchImpl: typeof fetch
): Promise<{
  ref: string;
  releaseUrl?: string;
  compareUrl?: string;
  publishedAt?: string;
  highlights: string[];
} | undefined> {
  const tags = await githubPaginated<GithubTag>(
    `${apiBaseUrl(manifest)}/repos/${repo}/tags`,
    manifest,
    fetchImpl
  );

  const latest = tags
    .map((tag) => tag.name)
    .sort((left, right) => compareVersions(left, right) * -1)[0];

  if (!latest) return undefined;

  const compare = await fetchCompare(repo, manifest, fetchImpl, latest);
  const { owner, repo: repoName } = splitRepo(repo);
  const compareUrl = compare?.html_url ?? `https://github.com/${owner}/${repoName}/releases/tag/${latest}`;
  return {
    ref: latest,
    compareUrl,
    releaseUrl: compareUrl,
    highlights: (compare?.commits ?? [])
      .map((commit) => commit.commit?.message?.split("\n")[0]?.trim())
      .filter((line): line is string => Boolean(line))
      .slice(0, 5)
  };
}

async function fetchCompare(
  repo: string,
  manifest: UpdateManifest,
  fetchImpl: typeof fetch,
  latestRef: string
): Promise<GithubCompare | undefined> {
  const normalized = normalizeVersion(latestRef);
  const refs = [normalized, `v${normalized}`];
  for (const base of refs) {
    try {
      return await githubJson<GithubCompare>(
        `${apiBaseUrl(manifest)}/repos/${repo}/compare/${base}...${latestRef}`,
        manifest,
        fetchImpl
      );
    } catch {
      continue;
    }
  }
  return undefined;
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
