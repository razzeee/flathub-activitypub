import {
  createFederation,
  exportJwk,
  type Federation,
  generateCryptoKeyPair,
  importJwk,
} from "@fedify/fedify";
import type { MessageQueue } from "@fedify/fedify";
import { D1KvStore } from "../store/fedify_kv.ts";
import { logEvent } from "../log.ts";
import {
  Accept,
  Announce,
  Create,
  Endpoints,
  Follow,
  Image,
  isActor,
  Note,
  PropertyValue,
  PUBLIC_COLLECTION,
  type Recipient,
  Service,
  Undo,
} from "@fedify/vocab";
import type { Config } from "../config.ts";
import { announceActivityId, appActorFields, appActorSummary } from "./activity.ts";
import { getCollectionActor } from "./collections.ts";
import type { Repositories } from "../store/d1_store.ts";

interface JwkKeyPairRecord {
  privateKey: JsonWebKey;
  publicKey: JsonWebKey;
}

export interface FederationData {
  repos: Repositories;
}

export function createFedifyFederation(
  config: Config,
  db: D1Database,
  queue?: MessageQueue,
): Federation<FederationData> {
  const federation = createFederation<FederationData>({
    origin: config.origin,
    kv: new D1KvStore(db),
    queue,
    manuallyStartQueue: true,
    permanentFailureStatusCodes: [404, 410, 451],
  });

  federation
    .setActorDispatcher("/apps/{identifier}", async (ctx, identifier) => {
      const profile = await ctx.data.repos.apps.get(identifier);
      const collection = getCollectionActor(identifier);
      if (!profile && !collection) return null;
      const keys = await ctx.getActorKeyPairs(identifier);
      return new Service({
        id: ctx.getActorUri(identifier),
        preferredUsername: identifier,
        name: profile?.name ?? collection?.name,
        summary: profile ? appActorSummary(profile) : collection?.summary,
        attachments: profile
          ? appActorFields(profile).map((field) => new PropertyValue(field))
          : undefined,
        url: new URL(
          profile?.flathubUrl ?? `${config.origin}/apps/${identifier}`,
        ),
        icon: profile?.iconUrl
          ? new Image({ url: new URL(profile.iconUrl) })
          : undefined,
        inbox: ctx.getInboxUri(identifier),
        outbox: ctx.getOutboxUri(identifier),
        followers: ctx.getFollowersUri(identifier),
        endpoints: new Endpoints({ sharedInbox: ctx.getInboxUri() }),
        publicKey: keys[0]?.cryptographicKey,
        assertionMethods: keys.map((key) => key.multikey),
      });
    })
    .setKeyPairsDispatcher(async (_ctx, identifier) => {
      return await getOrCreateActorKeyPairs(db, identifier);
    });

  federation.setFollowersDispatcher(
    "/apps/{identifier}/followers",
    async (ctx, identifier, _cursor, baseUri) => {
      const profile = await ctx.data.repos.apps.get(identifier);
      const collection = getCollectionActor(identifier);
      if (!profile && !collection) return null;
      let followers = await ctx.data.repos.followers.list(identifier);
      if (baseUri != null) {
        followers = followers.filter((follower) =>
          follower.actorId.startsWith(baseUri.href),
        );
      }
      const items: Recipient[] = followers.map((follower) => ({
        id: new URL(follower.actorId),
        inboxId: new URL(follower.inboxUrl),
        endpoints: follower.sharedInboxUrl
          ? { sharedInbox: new URL(follower.sharedInboxUrl) }
          : undefined,
      }));
      return { items };
    },
  );

  federation.setOutboxDispatcher(
    "/apps/{identifier}/outbox",
    async (ctx, identifier) => {
      const profile = await ctx.data.repos.apps.get(identifier);
      const actor = ctx.getActorUri(identifier);
      const followers = ctx.getFollowersUri(identifier);
      const collection = getCollectionActor(identifier);
      if (collection?.type === "post") {
        const posts = await ctx.data.repos.releases.listRecentPosts(
          collection.postKind,
        );
        return {
          items: posts.map(
            (post) =>
              new Announce({
                id: new URL(announceActivityId(post, collection.id)),
                actor,
                to: PUBLIC_COLLECTION,
                cc: followers,
                object: new URL(post.noteId),
              }),
          ),
        };
      }
      if (collection?.type === "app-list") {
        const apps = await ctx.data.repos.feeds.listAppProfiles(collection.id);
        return {
          items: apps.map(
            (app) =>
              new Announce({
                id: new URL(
                  `${actor.href}/announces/${encodeURIComponent(app.appId)}`,
                ),
                actor,
                to: PUBLIC_COLLECTION,
                cc: followers,
                object: ctx.getActorUri(app.appId),
              }),
          ),
        };
      }
      if (!profile) return null;
      const posts = await ctx.data.repos.releases.listPosts(identifier);
      return {
        items: posts.map(
          (post) =>
            new Create({
              id: new URL(post.createActivityId),
              actor,
              to: PUBLIC_COLLECTION,
              cc: followers,
              object: new Note({
                id: new URL(post.noteId),
                attribution: actor,
                to: PUBLIC_COLLECTION,
                cc: followers,
                content: post.contentHtml,
                url: new URL(post.noteId),
              }),
            }),
        ),
      };
    },
  );

  federation
    .setInboxListeners("/apps/{identifier}/inbox", "/inbox")
    .onRequestFinished((_ctx, report) => {
      logEvent("federation.inbox", {
        authentication: report.authentication.status,
        outcome: report.outcome.type,
        status:
          report.outcome.type === "response"
            ? report.outcome.status
            : undefined,
        attempts: report.attempts.map((attempt) => ({
          mechanism: attempt.mechanism,
          status: attempt.status,
          reason:
            attempt.status === "rejected" ? attempt.reason.type : undefined,
          checks: attempt.checks.map((check) => ({
            mechanism: check.mechanism,
            status: check.status,
            reason: check.status === "rejected" ? check.reason.type : undefined,
            fetchFailure:
              check.status === "rejected" &&
              check.reason.type === "keyFetchError"
                ? "error" in check.reason.result
                  ? check.reason.result.error.name
                  : check.reason.result.status
                : undefined,
          })),
        })),
      });
    })
    .on(Follow, async (ctx, follow) => {
      if (follow.objectId == null) return;
      const parsed = ctx.parseUri(follow.objectId);
      if (parsed?.type !== "actor") return;
      const profile = await ctx.data.repos.apps.get(parsed.identifier);
      const collection = getCollectionActor(parsed.identifier);
      if (!profile && !collection) return;
      const follower = await follow.getActor(ctx);
      if (
        !isActor(follower) ||
        follower.id == null ||
        follower.inboxId == null
      ) {
        return;
      }
      await ctx.data.repos.followers.put({
        appId: parsed.identifier,
        actorId: follower.id.href,
        inboxUrl: follower.inboxId.href,
        sharedInboxUrl: follower.endpoints?.sharedInbox?.href,
        acceptedAt: new Date().toISOString(),
      });
      await ctx.sendActivity(
        { identifier: parsed.identifier },
        follower,
        new Accept({
          actor: follow.objectId,
          object: follow,
        }),
        { preferSharedInbox: true },
      );
    })
    .on(Undo, async (ctx, undo) => {
      const object = await undo.getObject(ctx);
      if (!(object instanceof Follow) || object.objectId == null) return;
      const parsed = ctx.parseUri(object.objectId);
      if (parsed?.type !== "actor") return;
      const actorId = undo.actorId?.href ?? object.actorId?.href;
      if (!actorId) return;
      await ctx.data.repos.followers.delete(parsed.identifier, actorId);
    });

  federation.setOutboxPermanentFailureHandler(async (ctx, values) => {
    for (const actorId of values.actorIds) {
      for await (const appId of appIdsFromActivity(values.activity)) {
        await ctx.data.repos.followers.delete(appId, actorId.href);
      }
    }
  });

  return federation;
}

async function* appIdsFromActivity(activity: {
  actorId?: URL | null;
}): AsyncIterable<string> {
  if (activity.actorId == null) return;
  const parts = activity.actorId.pathname.split("/").filter(Boolean);
  if (parts[0] === "apps" && parts[1]) yield decodeURIComponent(parts[1]);
}

async function getOrCreateActorKeyPairs(
  db: D1Database,
  appId: string,
): Promise<CryptoKeyPair[]> {
  const rsa = await getOrCreateKeyPair(db, appId, "rsa", "RSASSA-PKCS1-v1_5");
  const ed25519 = await getOrCreateKeyPair(db, appId, "ed25519", "Ed25519");
  return [rsa, ed25519];
}

async function getOrCreateKeyPair(
  db: D1Database,
  appId: string,
  keyType: string,
  algorithm: "RSASSA-PKCS1-v1_5" | "Ed25519",
): Promise<CryptoKeyPair> {
  const load = async (): Promise<JwkKeyPairRecord | null> => {
    const row = await db
      .prepare("SELECT data FROM actor_keys WHERE app_id=? AND key_type=?")
      .bind(appId, keyType)
      .first<{ data: string }>();
    return row ? (JSON.parse(row.data) as JwkKeyPairRecord) : null;
  };
  const existing = await load();
  if (existing) {
    return {
      privateKey: await importJwk(existing.privateKey, "private"),
      publicKey: await importJwk(existing.publicKey, "public"),
    };
  }

  const generated = await generateCryptoKeyPair(algorithm);
  const record: JwkKeyPairRecord = {
    privateKey: await exportJwk(generated.privateKey),
    publicKey: await exportJwk(generated.publicKey),
  };
  const result = await db
    .prepare("INSERT OR IGNORE INTO actor_keys VALUES (?, ?, ?)")
    .bind(appId, keyType, JSON.stringify(record))
    .run();
  if (result.meta.changes > 0) return generated;

  const saved = await load();
  if (!saved) throw new Error(`failed to create keypair for ${appId}`);
  return {
    privateKey: await importJwk(saved.privateKey, "private"),
    publicKey: await importJwk(saved.publicKey, "public"),
  };
}
