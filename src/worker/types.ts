interface WorkerSecrets {
  API_KEY_PEPPER: string;
  AUDIT_IP_PEPPER: string;
  CLOUDFLARE_API_TOKEN: string;
  CLOUDFLARE_DOMAIN_TOKEN?: string;
  DELIVERABILITY_API_TOKEN: string;
  APNS_KEY_ID?: string;
  APNS_TEAM_ID?: string;
  APNS_PRIVATE_KEY?: string;
}

declare global {
  // Wrangler cannot infer secret names, so augment its generated binding interface with the deployed secrets.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Cloudflare {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface Env extends WorkerSecrets {}
  }
}

export type Env = Omit<Cloudflare.Env, "MAIL_QUEUE"> & {
  MAIL_QUEUE: Queue<MailQueueJob>;
};

export interface ApiKeyRow {
  id: string;
  name: string;
  secret_hash: string;
  scopes_json: string;
  expires_at: string | null;
  revoked_at: string | null;
  created_by: string | null;
  created_at: string;
  last_used_at: string | null;
  allowed_identities_json: string | null;
}

export interface IdentityRow {
  address: string;
  display_name: string;
  zone_id: string;
  routing_rule_id: string;
  enabled: number;
  kind: "routed" | "external";
  created_at: string;
  updated_at: string;
}

export interface ExternalAccountRow {
  identity_address: string;
  imap_host: string;
  imap_port: number;
  smtp_host: string;
  smtp_port: number;
  username: string;
  password_secret: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface ExternalSyncStateRow {
  identity_address: string;
  imap_folder: string;
  local_folder: "inbox" | "sent" | "archive" | "trash";
  uidvalidity: number | null;
  last_uid: number;
  backfill_done: number;
  synced_messages: number;
  skipped_messages: number;
  last_synced_at: string | null;
  last_error: string | null;
}

export interface ContactRow {
  identity_address: string;
  address: string;
  display_name: string;
  source: "learned" | "manual";
  send_count: number;
  first_sent_at: string | null;
  last_sent_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface InboundJob {
  id: string;
  rawKey: string;
  envelopeFrom: string;
  envelopeTo: string;
  receivedAt: string;
  size: number;
}

export interface PushJob {
  kind: "push";
  messageId: string;
}

// Written by the autopilot for mail a person is waiting on (reply-drafts.ts).
export interface DraftJob {
  kind: "draft";
  messageId: string;
}

export type MailQueueJob = InboundJob | PushJob | DraftJob;

export function isPushJob(job: MailQueueJob): job is PushJob {
  return "kind" in job && job.kind === "push";
}

export function isDraftJob(job: MailQueueJob): job is DraftJob {
  return "kind" in job && job.kind === "draft";
}

export interface AddressValue {
  name?: string;
  address: string;
}

export interface MessageRow {
  id: string;
  thread_id: string;
  message_id: string | null;
  in_reply_to: string | null;
  direction: "inbound" | "outbound";
  folder: "inbox" | "sent" | "archive" | "trash";
  subject: string;
  sender_name: string;
  sender_address: string;
  recipients_json: string;
  cc_json: string;
  preview: string;
  text_key: string | null;
  html_key: string | null;
  raw_key: string;
  received_at: string;
  unread: number;
  starred: number;
  has_attachments: number;
  attachment_count: number;
  stored_attachment_count: number;
  size: number;
  status: "pending" | "ready" | "failed";
  identity_address: string | null;
  sender_authenticated: number | null;
  external_folder: string | null;
  spam: number;
  spam_model: string | null;
  spam_checked_at: string | null;
  triage_category?: string | null;
  triage_confidence?: number | null;
  triage_needs_reply?: number | null;
  triage_urgency?: number | null;
  drafted_at?: string | null;
}

export type SendRequestStatus = "processing" | "reserved" | "sending" | "partial" | "complete" | "failed" | "unknown";

export interface SendRequestRow {
  key_id: string;
  idempotency_key: string;
  request_hash: string | null;
  message_id: string | null;
  message_row_id: string | null;
  status: SendRequestStatus;
  response_json: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface SendRecipientRow {
  recipient: string;
  kind: "to" | "cc" | "bcc";
  status: "pending" | "sending" | "sent" | "failed" | "unknown";
  attempts: number;
  provider_message_id: string | null;
  error_message: string | null;
}

export interface AttachmentRow {
  id: string;
  message_id: string;
  filename: string;
  content_type: string;
  content_id: string | null;
  object_key: string;
  size: number;
  disposition: string;
}
