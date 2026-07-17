export interface AppProfile {
  appId: string;
  name: string;
  summary?: string;
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

export interface PostRecord {
  appId: string;
  releaseFingerprint: string;
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

export interface CrawlState {
  watermarkUpdatedAt: number;
  completedAt: string;
}

export interface BootstrapState {
  currentPage: number;
  currentAppId?: string;
  completed: boolean;
  updatedAt: string;
}
