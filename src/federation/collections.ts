import type { PostKind } from "../store/types.ts";

export type FlathubCollectionName =
  | "recently-updated"
  | "recently-added"
  | "trending"
  | "popular";

interface BaseCollectionActorProfile {
  id: string;
  name: string;
  summary: string;
  flathubCollection: FlathubCollectionName;
}

export interface PostCollectionActorProfile extends BaseCollectionActorProfile {
  type: "post";
  postKind: PostKind;
}

export interface AppCollectionActorProfile extends BaseCollectionActorProfile {
  type: "app-list";
}

export type CollectionActorProfile =
  | PostCollectionActorProfile
  | AppCollectionActorProfile;

export const COLLECTION_ACTORS: CollectionActorProfile[] = [
  {
    id: "recent-releases",
    name: "Recent releases",
    summary: "Release notes as they land",
    type: "post",
    postKind: "release",
    flathubCollection: "recently-updated",
  },
  {
    id: "new-apps",
    name: "New apps",
    summary: "Apps that just arrived",
    type: "post",
    postKind: "new-app",
    flathubCollection: "recently-added",
  },
  {
    id: "trending-apps",
    name: "Trending apps",
    summary: "Apps people are checking out now",
    type: "app-list",
    flathubCollection: "trending",
  },
  {
    id: "popular-apps",
    name: "Popular apps",
    summary: "The most-followed app shelf",
    type: "app-list",
    flathubCollection: "popular",
  },
];

export function getCollectionActor(
  id: string,
): CollectionActorProfile | undefined {
  return COLLECTION_ACTORS.find((actor) => actor.id === id);
}

export function postCollectionActors(): PostCollectionActorProfile[] {
  return COLLECTION_ACTORS.filter((
    actor,
  ): actor is PostCollectionActorProfile => actor.type === "post");
}

export function appCollectionActors(): AppCollectionActorProfile[] {
  return COLLECTION_ACTORS.filter((actor): actor is AppCollectionActorProfile =>
    actor.type === "app-list"
  );
}
