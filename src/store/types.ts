export interface AppProfile {
  appId: string;
  name: string;
  summary?: string;
  descriptionHtml?: string;
  iconUrl?: string;
  flathubUrl: string;
  lastSeenUpdatedAt: number;
  createdAt: string;
  updatedAt: string;
}

export interface ReleaseRecord {
  appId: string;
  fingerprint: string;
  version: string;
  timestamp: string;
  date: string;
  type: string;
  urgency: string;
  descriptionHtml: string;
  url?: string;
  firstSeenAt: string;
  publishedAt?: string;
}

export type PostKind = "release" | "new-app";

export interface PostRecord {
  appId: string;
  releaseFingerprint: string;
  kind?: PostKind;
  noteId: string;
  createActivityId: string;
  contentHtml: string;
  publishedAt: string;
  deliveryState: "pending" | "queued" | "delivered" | "failed";
}

export interface FollowerRecord {
  appId: string;
  actorId: string;
  inboxUrl: string;
  sharedInboxUrl?: string;
  acceptedAt: string;
  lastDeliveryFailureAt?: string;
}

export interface FeedAppRecord {
  feedId: string;
  appId: string;
  rank: number;
  observedAt: string;
}

export interface CrawlState {
  watermarkUpdatedAt: number;
  completedAt: string;
}

export interface RecentlyAddedState {
  watermarkAddedAt: number;
  completedAt: string;
}

export interface BootstrapState {
  currentPage: number;
  currentAppId?: string;
  completed: boolean;
  updatedAt: string;
}
