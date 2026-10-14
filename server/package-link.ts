import { parseJson, type JsonValue } from "./schema.ts";
import { isBotPackage, parseBotPackage, type ParsedBotPackage } from "./bot-package.ts";
import { parseTeamManifest, type ParsedTeamManifest } from "./team-manifest.ts";

// Shared bot packages from public GitHub links: the bosbot://install deep
// link and the marketplace's "add from a link" both come through here.
// Only raw.githubusercontent.com is ever fetched.

const MAX_MANIFEST_BYTES = 1_000_000;

type Fetcher = typeof fetch;

async function fetchJson(url: string, maxBytes: number, fetcher: Fetcher): Promise<JsonValue> {
  const response = await fetcher(url, {
    headers: { accept: "application/json, text/plain;q=0.9" },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const error = Object.assign(new Error(`GitHub returned HTTP ${response.status}`), { status: response.status });
    throw error;
  }
  const announced = Number(response.headers.get("content-length") ?? 0);
  if (announced > maxBytes) throw new Error("The remote team file is too large");
  const raw = await response.text();
  if (Buffer.byteLength(raw) > maxBytes) throw new Error("The remote team file is too large");
  try {
    return parseJson(raw);
  } catch {
    throw new Error("GitHub did not return valid JSON");
  }
}

async function fetchText(url: string, maxBytes: number, fetcher: Fetcher): Promise<string> {
  const response = await fetcher(url, {
    headers: { accept: "text/markdown, text/plain;q=0.9" },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw Object.assign(new Error(`GitHub returned HTTP ${response.status}`), { status: response.status });
  const announced = Number(response.headers.get("content-length") ?? 0);
  if (announced > maxBytes) throw new Error("The remote team file is too large");
  const raw = await response.text();
  if (Buffer.byteLength(raw) > maxBytes) throw new Error("The remote team file is too large");
  return raw;
}

export type ParsedShareableTeam = ParsedTeamManifest | ParsedBotPackage;

function parseShareable(value: JsonValue | string): ParsedShareableTeam {
  if (typeof value === "string") return parseBotPackage(value);
  return isBotPackage(value) ? parseBotPackage(value) : parseTeamManifest(value);
}

async function fetchShareable(url: string, fetcher: Fetcher): Promise<ParsedShareableTeam> {
  return url.endsWith(".md")
    ? parseBotPackage(await fetchText(url, MAX_MANIFEST_BYTES, fetcher))
    : parseShareable(await fetchJson(url, MAX_MANIFEST_BYTES, fetcher));
}

function safeSegment(value: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(value) && value !== "." && value !== "..";
}

/** Resolve only public GitHub Markdown playbooks and legacy JSON team files.
 * Other hosts never reach server fetch. */
export function githubManifestUrls(input: string): string[] {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error("Enter a valid GitHub URL");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) {
    throw new Error("Only public HTTPS GitHub links are supported");
  }
  const parts = url.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
  if (!parts.every(safeSegment)) throw new Error("That GitHub path is not supported");

  if (url.hostname === "github.com" || url.hostname === "www.github.com") {
    if (parts.length === 2) {
      const [owner, repo] = parts;
      return [
        `https://raw.githubusercontent.com/${owner}/${repo}/main/botmrr.md`,
        `https://raw.githubusercontent.com/${owner}/${repo}/main/team.md`,
        `https://raw.githubusercontent.com/${owner}/${repo}/main/team.mausteam.json`,
        `https://raw.githubusercontent.com/${owner}/${repo}/master/botmrr.md`,
        `https://raw.githubusercontent.com/${owner}/${repo}/master/team.md`,
        `https://raw.githubusercontent.com/${owner}/${repo}/master/team.mausteam.json`,
      ];
    }
    if (parts.length >= 5 && (parts[2] === "blob" || parts[2] === "raw")) {
      const [owner, repo, , ref, ...file] = parts;
      if (!file.at(-1)?.match(/\.(?:md|json)$/)) throw new Error("The GitHub link must point to a Markdown playbook or JSON team file");
      return [`https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${file.join("/")}`];
    }
  }

  if (url.hostname === "raw.githubusercontent.com" && parts.length >= 4) {
    if (!parts.at(-1)?.match(/\.(?:md|json)$/)) throw new Error("The GitHub link must point to a Markdown playbook or JSON team file");
    return [`https://raw.githubusercontent.com/${parts.join("/")}`];
  }

  throw new Error("Paste a GitHub repository, Markdown playbook, or legacy JSON team link");
}

export async function fetchGithubTeam(input: string, fetcher: Fetcher = fetch): Promise<ParsedShareableTeam> {
  const urls = githubManifestUrls(input);
  let lastError: unknown;
  for (const url of urls) {
    try {
      return await fetchShareable(url, fetcher);
    } catch (error) {
      lastError = error;
      if ((error as { status?: number }).status !== 404) throw error;
    }
  }
  throw lastError ?? new Error("No botmrr.md, team.md, or legacy team file was found in that repository");
}
// branding compatibility (electron/branding-compat.json): wire-formats: stored backups, portable packages and peer metadata retain their schema identifiers
