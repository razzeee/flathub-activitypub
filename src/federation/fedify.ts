import {
  createFederation,
  exportJwk,
  type Federation,
  generateCryptoKeyPair,
  importJwk,
} from "@fedify/fedify";
import { DenoKvMessageQueue, DenoKvStore } from "@fedify/denokv";
import {
  Accept,
  Announce,
  Create,
  Endpoints,
  Follow,
  Image,
  isActor,
  Note,
  PUBLIC_COLLECTION,
  type Recipient,
  Service,
  Undo,
} from "@fedify/vocab";
import type { Config } from "../config.ts";
import { announceActivityId, appActorSummary } from "./activity.ts";
import { getCollectionActor } from "./collections.ts";
import type { Repositories } from "../store/kv_store.ts";

interface JwkKeyPairRecord {
  privateKey: JsonWebKey;
  publicKey: JsonWebKey;
}

export interface FederationData {
  repos: Repositories;
}

export function createFedifyFederation(
  config: Config,
  kv: Deno.Kv,
): Federation<FederationData> {
  const federation = createFederation<FederationData>({
    origin: config.origin,
    kv: new DenoKvStore(kv),
    ...(config.fedifyQueue === "kv"
      ? { queue: new DenoKvMessageQueue(kv), manuallyStartQueue: true }
      : {}),
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
      return await getOrCreateActorKeyPairs(kv, identifier);
    });

  federation
    .setFollowersDispatcher(
      "/apps/{identifier}/followers",
      async (ctx, identifier, _cursor, baseUri) => {
        const profile = await ctx.data.repos.apps.get(identifier);
        const collection = getCollectionActor(identifier);
        if (!profile && !collection) return null;
        let followers = await ctx.data.repos.followers.list(identifier);
        if (baseUri != null) {
          followers = followers.filter((follower) =>
            follower.actorId.startsWith(baseUri.href)
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
          items: posts.map((post) =>
            new Announce({
              id: new URL(announceActivityId(post, collection.id)),
              actor,
              to: PUBLIC_COLLECTION,
              cc: followers,
              object: new URL(post.noteId),
            })
          ),
        };
      }
      if (collection?.type === "app-list") {
        const apps = await ctx.data.repos.feeds.listAppProfiles(collection.id);
        return {
          items: apps.map((app) =>
            new Announce({
              id: new URL(
                `${actor.href}/announces/${encodeURIComponent(app.appId)}`,
              ),
              actor,
              to: PUBLIC_COLLECTION,
              cc: followers,
              object: ctx.getActorUri(app.appId),
            })
          ),
        };
      }
      if (!profile) return null;
      const posts = await ctx.data.repos.releases.listPosts(identifier);
      return {
        items: posts.map((post) =>
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
          })
        ),
      };
    },
  );

  federation
    .setInboxListeners("/apps/{identifier}/inbox", "/inbox")
    .on(Follow, async (ctx, follow) => {
      if (follow.objectId == null) return;
      const parsed = ctx.parseUri(follow.objectId);
      if (parsed?.type !== "actor") return;
      const profile = await ctx.data.repos.apps.get(parsed.identifier);
      const collection = getCollectionActor(parsed.identifier);
      if (!profile && !collection) return;
      const follower = await follow.getActor(ctx);
      if (
        !isActor(follower) || follower.id == null || follower.inboxId == null
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

async function* appIdsFromActivity(
  activity: { actorId?: URL | null },
): AsyncIterable<string> {
  if (activity.actorId == null) return;
  const parts = activity.actorId.pathname.split("/").filter(Boolean);
  if (parts[0] === "apps" && parts[1]) yield decodeURIComponent(parts[1]);
}

async function getOrCreateActorKeyPairs(
  kv: Deno.Kv,
  appId: string,
): Promise<CryptoKeyPair[]> {
  const rsa = await getOrCreateKeyPair(kv, appId, "rsa", "RSASSA-PKCS1-v1_5");
  const ed25519 = await getOrCreateKeyPair(kv, appId, "ed25519", "Ed25519");
  return [rsa, ed25519];
}

async function getOrCreateKeyPair(
  kv: Deno.Kv,
  appId: string,
  keyType: string,
  algorithm: "RSASSA-PKCS1-v1_5" | "Ed25519",
): Promise<CryptoKeyPair> {
  const key = ["keypair", appId, keyType];
  const existing = await kv.get<JwkKeyPairRecord>(key);
  if (existing.value) {
    return {
      privateKey: await importJwk(existing.value.privateKey, "private"),
      publicKey: await importJwk(existing.value.publicKey, "public"),
    };
  }

  const generated = await generateCryptoKeyPair(algorithm);
  const record: JwkKeyPairRecord = {
    privateKey: await exportJwk(generated.privateKey),
    publicKey: await exportJwk(generated.publicKey),
  };
  const result = await kv.atomic().check(existing).set(key, record).commit();
  if (result.ok) return generated;

  const saved = await kv.get<JwkKeyPairRecord>(key);
  if (!saved.value) throw new Error(`failed to create keypair for ${appId}`);
  return {
    privateKey: await importJwk(saved.value.privateKey, "private"),
    publicKey: await importJwk(saved.value.publicKey, "public"),
  };
}
