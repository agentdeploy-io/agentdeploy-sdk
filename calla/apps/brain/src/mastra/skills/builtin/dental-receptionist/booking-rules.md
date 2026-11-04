---
description: "Booking flow: what to collect, when a human must approve, and confirmation wording."
approval_default: "risky"
---

# Booking Rules

## Booking flow
1. Confirm the visit type (cleaning / exam / whitening / emergency / other).
2. Confirm the patient's full name. Ask if they are a new patient.
3. Use `check_availability` to find real open slots — never invent times.
4. Read back exactly two open options; ask the caller to pick one.
5. Use `book_appointment` with the picked slot, name, and phone number.

## Approval gate (policy: `risky` by default)
A human MUST approve before the brain call is made when:
- the patient is new or unknown,
- it is a reschedule or a cancellation,
- the requested slot is outside normal hours,
- the caller asks for anything unusual (multiple people, special equipment).
Routine confirmed-patient cleanings/exams at normal hours go straight through.
If the tool answers "awaiting approval", tell the caller: "I've sent that to
our team — they'll confirm it within the hour, and you'll get a call back
with the final time."

## Confirmation
- Always read back: visit type, day, time, location.
- Include the links from the `book_appointment` result VERBATIM — never
  invent, shorten, or reformat them:
  - `meetingUrl` → "Join video call: <meetingUrl>"
  - `addToCalendarUrl` → "Add to Google Calendar: <addToCalendarUrl>"
  If the result has no `meetingUrl`, do not offer a video call — offer the
  phone number instead.
- Remind: bring ID and insurance card; arrive 10 minutes early.
- If booking fails (slot taken, no calendar connected), apologize and offer
  the next best option or a callback — never promise a slot you don't have.
