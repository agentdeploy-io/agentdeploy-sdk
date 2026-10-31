export type LeadStage =
  | "raw"
  | "verified"
  | "classified"
  | "researched"
  | "approved"
  | "sent"
  | "replied"
  | "rejected"
  | "opted_out"
  | "blacklisted";

export type LeadStatus =
  | "pending_review"
  | "approved"
  | "rejected"
  | "sent"
  | "replied"
  | "opted_out";

export type WebsiteStatus = "none" | "candidate" | "verified" | "flagged" | "rejected";

export interface EmailEntry {
  addr: string;
  kind: "role" | "personal";
  source: string;
  confidence: number;
  mx_ok?: boolean;
}

export interface PhoneEntry {
  num: string;
  source: string;
  country?: string;
}

export interface SocialsMap {
  linkedin?: string[];
  twitter?: string[];
}

export interface WebsiteEvidence {
  footer?: boolean;
  title?: boolean;
  ogSiteName?: boolean;
  addressMatch?: boolean;
  regOnPage?: boolean;
  snippet?: string;
}

export interface Lead {
  key: string;
  country: string;
  name: string;
  reg_number?: string | null;
  sic?: string | null;
  sic_label?: string | null;
  incorporated?: string | null;
  address?: string | null;
  city?: string | null;
  website?: string | null;
  website_status?: WebsiteStatus;
  website_evidence?: string | null;
  emails?: string | null;
  phones?: string | null;
  socials?: string | null;
  contact_name?: string | null;
  contact_role?: string | null;
  source?: string | null;
  source_url?: string | null;
  stage: LeadStage;
  classification?: string | null;
  research?: string | null;
  pitch_subject?: string | null;
  pitch_body?: string | null;
  status?: LeadStatus;
  created_at?: string | null;
  updated_at?: string | null;
  last_sync_at?: string | null;
  manychat_subscriber_id?: string | null;
}

export interface LeadPatch {
  country?: string;
  name?: string;
  reg_number?: string | null;
  sic?: string | null;
  sic_label?: string | null;
  incorporated?: string | null;
  address?: string | null;
  city?: string | null;
  website?: string | null;
  website_status?: WebsiteStatus;
  website_evidence?: string | null;
  emails?: string | null;
  phones?: string | null;
  socials?: string | null;
  contact_name?: string | null;
  contact_role?: string | null;
  source?: string | null;
  source_url?: string | null;
  stage?: LeadStage;
  classification?: string | null;
  research?: string | null;
  pitch_subject?: string | null;
  pitch_body?: string | null;
  status?: LeadStatus;
  updated_at?: string;
  last_sync_at?: string;
  manychat_subscriber_id?: string | null;
}

export interface LeadListFilters {
  stage?: LeadStage;
  country?: string;
  tier?: string;
  status?: LeadStatus;
  page?: number;
  pageSize?: number;
}

export interface LeadListResult {
  rows: Lead[];
  total: number;
  page: number;
  pageSize: number;
}

export type CrawlTrigger = "cron" | "manual" | "handoff";
export type CrawlState = "running" | "succeeded" | "failed" | "stopped";

export interface CrawlRunStats {
  candidates?: number;
  verified?: number;
  withEmail?: number;
  mxOk?: number;
  synced?: number;
  rejected?: number;
}

export interface CrawlRunParams {
  limit?: number;
  queries?: Record<string, string[]>;
  icpRef?: string;
}

export interface CrawlRun {
  id?: number;
  started_at: string;
  finished_at?: string | null;
  trigger: CrawlTrigger;
  countries: string;
  params?: string | null;
  state: CrawlState;
  vm_minutes?: number | null;
  tokens_used?: number | null;
  stats?: string | null;
}

export interface SyncWatermark {
  id: number;
  last_rowid: number;
  last_synced_at: string | null;
}

export type SentStatus = "dry-run" | "queued" | "sent" | string;

export interface SentLogEntry {
  id?: number;
  lead_key: string;
  email: string;
  subject?: string | null;
  message_id?: string | null;
  status: SentStatus;
  at: string;
  channel?: ReplyChannel | null;
}

export type ReplyIntent = "interested" | "question" | "not_interested" | "opt_out" | "spam";
export type DraftStatus = "pending" | "approved" | "sent" | "discarded";
export type ReplyChannel = "email" | "manychat";

export interface RepliesLogEntry {
  id?: number;
  lead_key: string;
  reply_from: string;
  reply_subject?: string | null;
  reply_body?: string | null;
  intent?: ReplyIntent | null;
  draft?: string | null;
  draft_status?: DraftStatus | null;
  at: string;
  channel?: ReplyChannel | null;
}

export type BlacklistKind = "email" | "domain" | "company" | "any";

export interface BlacklistEntry {
  id: string;
  kind: BlacklistKind;
  note?: string | null;
  created_at: string;
}

export interface BlacklistCheck {
  email?: string;
  domain?: string;
  company?: string;
}

export interface InboundSeen {
  id: number;
  ids: string;
  updated_at: string;
}

export interface SettingsMap {
  [key: string]: string;
}

export interface DefaultSettings {
  paused: boolean;
  dryRun: boolean;
  sendEnabled: boolean;
  dailyCap: number;
  dmDryRun: boolean;
  dmEnabled: boolean;
  dmDailyCap: number;
  /** Drafted email replies are sent immediately (human-in-the-loop off). */
  autoSendReplies: boolean;
  [key: string]: boolean | number | string;
}

export interface StageCounts {
  [stage: string]: number;
}
