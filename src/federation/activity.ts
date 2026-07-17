import type { AppProfile, PostRecord } from "../store/types.ts";
import { hashtagsForPost } from "../releases.ts";

export const ACTIVITYSTREAMS_PUBLIC =
  "https://www.w3.org/ns/activitystreams#Public";

export function actorId(origin: string, appId: string): string {
  return `${origin}/apps/${encodeURIComponent(appId)}`;
}

export function followersId(origin: string, appId: string): string {
  return `${actorId(origin, appId)}/followers`;
}

export function outboxId(origin: string, appId: string): string {
  return `${actorId(origin, appId)}/outbox`;
}

export function noteId(
  origin: string,
  appId: string,
  fingerprint: string,
): string {
  return `${actorId(origin, appId)}/releases/${fingerprint}`;
}

export function newAppNoteId(origin: string, appId: string): string {
  return `${actorId(origin, appId)}/posts/new-app`;
}

export function createActivityId(noteUrl: string): string {
  return `${noteUrl}#create`;
}

export function announceActivityId(
  post: PostRecord,
  actorId: string,
): string {
  return `${post.noteId}#announce-${encodeURIComponent(actorId)}`;
}

export function appActorSummary(profile: AppProfile): string {
  const source = profile.descriptionHtml?.trim()
    ? profile.descriptionHtml.trim()
    : profile.summary
    ? `<p>${escapeHtml(profile.summary)}</p>`
    : "";
  const name = escapeHtml(profile.name || profile.appId);
  return [
    source,
    `<p>Unofficial ActivityPub mirror for ${name} on Flathub. Follow for release notes observed by this server.</p>`,
  ].filter(Boolean).join("\n");
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(
    ">",
    "&gt;",
  );
}

export function actorDocument(
  origin: string,
  profile: AppProfile,
): Record<string, unknown> {
  const id = actorId(origin, profile.appId);
  return {
    "@context": [
      "https://www.w3.org/ns/activitystreams",
      "https://w3id.org/security/v1",
    ],
    id,
    type: "Service",
    preferredUsername: profile.appId,
    name: profile.name,
    summary: appActorSummary(profile),
    url: profile.flathubUrl,
    icon: profile.iconUrl ? { type: "Image", url: profile.iconUrl } : undefined,
    inbox: `${id}/inbox`,
    outbox: outboxId(origin, profile.appId),
    followers: followersId(origin, profile.appId),
  };
}

export function noteDocument(
  origin: string,
  post: PostRecord,
): Record<string, unknown> {
  return {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: post.noteId,
    type: "Note",
    attribution: actorId(origin, post.appId),
    to: [ACTIVITYSTREAMS_PUBLIC],
    cc: [followersId(origin, post.appId)],
    published: post.publishedAt,
    content: post.contentHtml,
    tag: hashtagsForPost(post.kind).map((name) => ({
      type: "Hashtag",
      name: `#${name}`,
    })),
    url: post.noteId,
  };
}

export function createActivity(
  origin: string,
  post: PostRecord,
): Record<string, unknown> {
  return {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: post.createActivityId,
    type: "Create",
    actor: actorId(origin, post.appId),
    to: [ACTIVITYSTREAMS_PUBLIC],
    cc: [followersId(origin, post.appId)],
    object: noteDocument(origin, post),
  };
}

export function announceActivity(
  origin: string,
  actorIdValue: string,
  post: PostRecord,
): Record<string, unknown> {
  return {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: announceActivityId(post, actorIdValue),
    type: "Announce",
    actor: actorId(origin, actorIdValue),
    to: [ACTIVITYSTREAMS_PUBLIC],
    cc: [followersId(origin, actorIdValue)],
    object: post.noteId,
  };
}

export function appAnnounceActivity(
  origin: string,
  actorIdValue: string,
  appId: string,
): Record<string, unknown> {
  return {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: `${actorId(origin, actorIdValue)}/announces/${
      encodeURIComponent(appId)
    }`,
    type: "Announce",
    actor: actorId(origin, actorIdValue),
    to: [ACTIVITYSTREAMS_PUBLIC],
    cc: [followersId(origin, actorIdValue)],
    object: actorId(origin, appId),
  };
}

export function webfinger(
  origin: string,
  appId: string,
): Record<string, unknown> {
  const host = new URL(origin).host;
  return {
    subject: `acct:${appId}@${host}`,
    aliases: [actorId(origin, appId)],
    links: [{
      rel: "self",
      type: "application/activity+json",
      href: actorId(origin, appId),
    }],
  };
}
