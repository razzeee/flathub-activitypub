import { crypto } from "@std/crypto/crypto";
import { encodeHex } from "@std/encoding/hex";
import type { AppstreamRelease } from "./flathub/client.ts";
import type { AppProfile, PostKind } from "./store/types.ts";

export interface NormalizedRelease {
  fingerprint: string;
  version: string;
  timestamp: string;
  date: string;
  type: string;
  urgency: string;
  descriptionHtml: string;
  url?: string;
}

export const RELEASE_HASHTAGS = ["Flathub", "LinuxApps"];
export const NEW_APP_HASHTAGS = ["Flathub", "LinuxApps", "NewOnFlathub"];

export async function normalizeRelease(
  appId: string,
  release: AppstreamRelease,
): Promise<NormalizedRelease | null> {
  const descriptionHtml = sanitizeHtml(release.description ?? "");
  if (descriptionHtml.trim() === "") return null;

  const version = (release.version ?? "").trim();
  const timestamp = release.timestamp == null
    ? ""
    : String(release.timestamp).trim();
  const date = (release.date ?? "").trim();
  const type = (release.type ?? "").trim();
  const urgency = (release.urgency ?? "").trim();
  const descriptionHash = await sha256(collapseWhitespace(descriptionHtml));
  const fingerprint = await sha256(
    [appId, version, timestamp, date, type, descriptionHash].join("\u001f"),
  );

  return {
    fingerprint,
    version,
    timestamp,
    date,
    type,
    urgency,
    descriptionHtml,
    url: release.url?.trim() || undefined,
  };
}

export async function normalizeReleases(
  appId: string,
  releases: AppstreamRelease[],
): Promise<NormalizedRelease[]> {
  const normalized = await Promise.all(
    releases.map((release) => normalizeRelease(appId, release)),
  );
  return normalized.filter((release): release is NormalizedRelease =>
    release !== null
  );
}

export function latestRelease(
  releases: NormalizedRelease[],
  now = new Date(),
): NormalizedRelease | undefined {
  const cutoff = now.valueOf();
  const eligible = releases.filter((release) => {
    const time = releaseInstant(release);
    return time == null || time <= cutoff;
  });
  return [...eligible].sort(compareReleases).at(0);
}

export function compareReleases(
  a: NormalizedRelease,
  b: NormalizedRelease,
): number {
  const aTime = releaseTime(a);
  const bTime = releaseTime(b);
  if (aTime !== bTime) return bTime - aTime;
  return b.fingerprint.localeCompare(a.fingerprint);
}

export function sanitizeHtml(input: string): string {
  const html = input.trim();
  if (html === "") return "";

  const withoutExecutableBlocks = html.replace(
    /<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi,
    "",
  );

  return withoutExecutableBlocks.replace(/<[^>]*>|[^<]+/g, (part) => {
    if (!part.startsWith("<")) return escapeHtml(part);
    return sanitizeTag(part);
  }).trim();
}

function sanitizeTag(tag: string): string {
  const match = /^<\s*(\/)?\s*([a-zA-Z0-9:-]+)/.exec(tag);
  if (!match) return "";
  const closing = match[1] === "/";
  const tagName = match[2].toLowerCase();

  if (!ALLOWED_TAGS.has(tagName)) return "";
  if (closing) return `</${tagName}>`;
  if (tagName === "br") return "<br>";
  if (tagName !== "a") return `<${tagName}>`;

  const href = safeHref(tag);
  return href == null ? "<a>" : `<a href="${escapeAttribute(href)}">`;
}

const ALLOWED_TAGS = new Set([
  "a",
  "b",
  "br",
  "code",
  "em",
  "i",
  "li",
  "ol",
  "p",
  "pre",
  "section",
  "strong",
  "ul",
]);

function safeHref(tag: string): string | null {
  const match = /\s+href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
  const href = (match?.[1] ?? match?.[2] ?? match?.[3])?.trim();
  if (!href || /[&<>]/.test(href)) return null;
  try {
    const url = new URL(href);
    return ["http:", "https:", "mailto:"].includes(url.protocol) ? href : null;
  } catch {
    return null;
  }
}

export function buildNoteContent(
  appName: string,
  appId: string,
  release: NormalizedRelease,
): string {
  const label = [escapeHtml(appName || appId), escapeHtml(release.version)]
    .filter(Boolean).join(" ");
  const date = release.date ? ` on ${escapeHtml(release.date)}` : "";
  const flathubUrl = `https://flathub.org/apps/${encodeURIComponent(appId)}`;
  return [
    `<p><strong>${label}</strong> was released on Flathub${date}.</p>`,
    `<section>${release.descriptionHtml}</section>`,
    `<p><a href="${flathubUrl}">View on Flathub</a></p>`,
    hashtagParagraph(RELEASE_HASHTAGS),
  ].join("\n");
}

export function buildNewAppNoteContent(profile: AppProfile): string {
  const name = escapeHtml(profile.name || profile.appId);
  const summary = profile.summary
    ? `<p>${escapeHtml(profile.summary)}</p>`
    : "";
  return [
    `<p><strong>${name}</strong> was added to Flathub.</p>`,
    summary,
    `<p><a href="${
      escapeAttribute(profile.flathubUrl)
    }">View on Flathub</a></p>`,
    hashtagParagraph(NEW_APP_HASHTAGS),
  ].filter(Boolean).join("\n");
}

export function hashtagsForPost(kind?: PostKind): string[] {
  return kind === "new-app" ? NEW_APP_HASHTAGS : RELEASE_HASHTAGS;
}

export function releasePublishedAt(
  release: NormalizedRelease,
  fallback = new Date(),
): string {
  const time = releaseInstant(release);
  if (time != null && time <= fallback.valueOf()) {
    return new Date(time).toISOString();
  }
  return fallback.toISOString();
}

function releaseInstant(release: NormalizedRelease): number | null {
  if (release.timestamp !== "") {
    const seconds = Number(release.timestamp);
    if (Number.isFinite(seconds) && seconds > 0) {
      return seconds * 1000;
    }
  }
  if (release.date !== "") {
    const date = new Date(release.date);
    const time = date.valueOf();
    if (!Number.isNaN(time)) return time;
  }
  return null;
}

function releaseTime(release: NormalizedRelease): number {
  return releaseInstant(release) ?? 0;
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(
    ">",
    "&gt;",
  );
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replaceAll('"', "&quot;");
}

function hashtagParagraph(hashtags: string[]): string {
  return `<p>${hashtags.map((tag) => `#${tag}`).join(" ")}</p>`;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return encodeHex(digest);
}
