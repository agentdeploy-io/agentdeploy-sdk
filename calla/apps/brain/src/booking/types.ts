/**
 * Booking module — shared types (no runtime deps beyond node:crypto/fetch).
 *
 * Domain: appointment booking for property-survey reps in Ireland. The default
 * timezone is Europe/Dublin everywhere; all wire timestamps are ISO-8601 UTC
 * strings, and all local-time math goes through scheduling.ts (Intl-based).
 */

/** Calendar provider backing a rep's availability + bookings. */
export type BookingProvider = "calendly" | "google" | "microsoft";

/** Appointment lifecycle as stored/returned by the booking module. */
export type AppointmentStatus = "confirmed" | "tentative" | "cancelled";

/**
 * Weekly work hours. `days` uses ISO-ish numbering (1 = Monday … 7 = Sunday;
 * the Irish survey default is Mon–Fri). start/end are "HH:MM" wall-clock in
 * the rep's timezone.
 */
export interface WorkHours {
  days: number[];
  start: string;
  end: string;
}

/** A bookable representative (surveyor) tied to one calendar provider. */
export interface Rep {
  id: string;
  name: string;
  email: string;
  provider: BookingProvider;
  /** Provider account id (Google sub / Graph user id) set after OAuth connect. */
  accountId?: string;
  /** Calendly scheduling link (calendly reps only). */
  schedulingLink?: string;
  /** Calendly event-type URI used to match incoming webhooks to this rep. */
  eventTypeUri?: string;
  /** IANA timezone — defaults to Europe/Dublin (target market: Ireland). */
  timezone?: string;
  workHours: WorkHours;
  /** Slot length in minutes (default 45). */
  slotMinutes: number;
  /** Buffer kept free around existing appointments (default 15). */
  bufferMinutes: number;
  enabled: boolean;
}

/** Tenant-wide booking defaults; per-rep fields override where present. */
export interface BookingPolicy {
  slotMinutes: number;
  bufferMinutes: number;
  workHours: WorkHours;
  timezone: string;
  /** null = unlimited. Caps confirmed bookings per local day per rep. */
  maxBookingsPerDay: number | null;
}

/** The person being booked (data minimized — see README GDPR notes). */
export interface Attendee {
  name: string;
  email?: string;
  phone?: string;
}

/** Optional business context attached to an appointment. */
export interface BookingContext {
  leadKey?: string;
  propertyAddress?: string;
  notes?: string;
}

/** A booked (or cancelled) appointment, normalized across providers. */
export interface Appointment {
  id: string;
  provider: BookingProvider;
  repId: string;
  attendee: Attendee;
  /** ISO-8601 UTC. */
  start: string;
  /** ISO-8601 UTC. */
  end: string;
  title: string;
  context?: BookingContext;
  status: AppointmentStatus;
  createdAt: string;
}

/** OAuth token material for a connected Google/Microsoft account. */
export interface ConnectionRecord {
  provider: BookingProvider;
  accountId: string;
  accessToken: string;
  refreshToken?: string;
  /** ISO-8601 UTC — access token considered expired at/after this instant. */
  expiresAt?: string;
  email?: string;
  /** Rep this connection was established for (set by the OAuth callback). */
  repId?: string;
  createdAt?: string;
}

/** One bookable slot (ISO-8601 UTC start/end). */
export interface Slot {
  start: string;
  end: string;
}

/** A busy interval on a calendar (ISO-8601 UTC start/end). */
export interface BusyRange {
  start: string;
  end: string;
}

/** Pending OAuth authorization-code flow state (cached, 10-min TTL). */
export interface OAuthStateRecord {
  provider: BookingProvider;
  repId: string;
  redirectUri: string;
  createdAt: string;
}

/** Token endpoint response (Google + Microsoft share this shape). */
export interface TokenResponse {
  accessToken: string;
  refreshToken?: string;
  /** ISO-8601 UTC; derived from expires_in with a safety margin. */
  expiresAt?: string;
  scope?: string;
  tokenType?: string;
}

/** Result of resolving a usable (fresh) connection for API calls. */
export type FreshConnection =
  | { ok: true; conn: ConnectionRecord }
  | {
      ok: false;
      reason: "not-connected" | "reconnect-required" | "provider-error";
      detail?: string;
    };

/**
 * Error thrown by provider API calls; `status` carries the upstream HTTP
 * status so routes can map 404s/401s through to the client.
 */
export class BookingApiError extends Error {
  readonly status?: number;
  readonly detail?: string;
  constructor(message: string, status?: number, detail?: string) {
    super(message);
    this.name = "BookingApiError";
    if (status !== undefined) this.status = status;
    if (detail !== undefined) this.detail = detail;
  }
}
