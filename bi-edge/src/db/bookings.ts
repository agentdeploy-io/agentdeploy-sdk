import type Database from "better-sqlite3";

const INSERT_BOOKING = `
  INSERT INTO bookings (lead_key, customer_email, start_at, end_at, title, calendar_link, status, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const SELECT_BY_LEAD = `
  SELECT * FROM bookings WHERE lead_key = ? ORDER BY id DESC
`;

const SELECT_RECENT = `
  SELECT * FROM bookings ORDER BY id DESC LIMIT ?
`;

export function insertBooking(
  db: Database.Database,
  b: {
    lead_key: string;
    customer_email: string;
    start_at: string;
    end_at: string;
    title: string;
    calendar_link?: string | null;
    status?: string;
  },
): number {
  const now = new Date().toISOString();
  const res = db
    .prepare(INSERT_BOOKING)
    .run(
      b.lead_key,
      b.customer_email,
      b.start_at,
      b.end_at,
      b.title,
      b.calendar_link ?? null,
      b.status ?? "confirmed",
      now,
      now,
    );
  return Number(res.lastInsertRowid);
}

export function listBookingsByLead(db: Database.Database, leadKey: string): Record<string, unknown>[] {
  return db.prepare(SELECT_BY_LEAD).all(leadKey) as Record<string, unknown>[];
}

export function listBookings(db: Database.Database, limit = 50): Record<string, unknown>[] {
  return db.prepare(SELECT_RECENT).all(limit) as Record<string, unknown>[];
}
