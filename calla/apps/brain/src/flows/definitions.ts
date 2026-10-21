/**
 * Builtin qualification flows — versioned in CODE (PUT /flows/definitions/:id
 * on a builtin returns 400 "builtin flows are versioned in code"). Custom
 * flows created via POST live in the store cache and are merged on read.
 *
 * Domain source: the client's Flowly brief — Irish retrofit/solar + property
 * (buyer/seller/landlord) enquiry qualification. Answer matching is
 * normalization-insensitive (case, spaces, –/—/- dashes, € symbols), so
 * "semi" → "Semi-detached", "<3 months" → "< 3 months", "€150-200" →
 * "€150–€200" all resolve (see runner.matchAnswer).
 *
 * URGENCY (roofing-style emergencies): any answer text containing one of
 * URGENCY_KEYWORDS flips run.priority to "high", audits "flow.urgent" and
 * best-effort relays a calla:message frame {urgent:true, …} to
 * {CALLA_EDGE_URL}/events/ingest so the UI live feed alerts a human
 * immediately. The flow itself continues (deterministic-first doctrine).
 */
import type { FlowDefinition } from "./types.js";

/** Free-text urgency scan (checked against EVERY inbound answer, any field). */
export const URGENCY_KEYWORDS = [
  "leak",
  "flooding",
  "emergency",
  "water damage",
  "storm damage",
] as const;

const TIMEFRAME_OPTIONS = ["< 3 months", "3–6 months", "6–12 months", "Just researching"];
const PROPERTY_TYPE_OPTIONS = [
  "Detached",
  "Semi-detached",
  "Terrace",
  "Apartment",
  "Bungalow",
];
const BEDROOM_OPTIONS = ["1", "2", "3", "4", "5+"];

// ─── Retrofit / solar ────────────────────────────────────────────

export const RETROFIT_SOLAR_QUALIFICATION: FlowDefinition = {
  id: "retrofit-solar-qualification",
  name: "Retrofit & Solar Qualification",
  vertical: "retrofit",
  description:
    "Qualifies a home-energy/solar enquiry (Flowly brief): tenure, property type, Eircode, electricity spend, existing solar, battery/EV interest, timeframe, grant questions, and survey readiness.",
  triggerKeywords: ["solar", "retrofit", "ber", "heat pump", "energy upgrade", "seai"],
  fields: [
    {
      name: "homeowner_or_tenant",
      question: "Thanks for reaching out! Quick question first — are you the homeowner or a tenant?",
      type: "choice",
      options: ["Homeowner", "Tenant"],
    },
    {
      name: "property_type",
      question: "What type of property is it?",
      type: "choice",
      options: PROPERTY_TYPE_OPTIONS,
    },
    {
      name: "eircode",
      question: "What's the property Eircode? (A Dublin district like \"Dublin 15\" works too.)",
      type: "eircode",
    },
    {
      name: "monthly_spend",
      question: "Roughly what's your monthly electricity spend?",
      type: "choice",
      options: ["Under €100", "€100–€150", "€150–€200", "Over €200"],
    },
    {
      name: "has_solar",
      question: "Do you already have solar panels installed?",
      type: "yesno",
    },
    {
      name: "battery_interest",
      question: "Would you be interested in adding a battery?",
      type: "yesno",
    },
    {
      name: "has_ev",
      question: "Do you have an electric vehicle (or plan to get one)?",
      type: "yesno",
    },
    {
      name: "timeframe",
      question: "When are you looking to get the work done?",
      type: "choice",
      options: TIMEFRAME_OPTIONS,
    },
    {
      name: "grant_questions",
      question: "Any questions about SEAI grants we can help with?",
      type: "text",
      required: false,
      optionalHint: "optional — reply \"skip\" to move on",
    },
    {
      name: "ready_for_survey",
      question: "Great — are you ready to book a free home survey?",
      type: "yesno",
    },
  ],
  scoring: [
    { field: "homeowner_or_tenant", equals: "Homeowner", weight: 20 },
    { field: "property_type", in: ["Detached", "Semi-detached", "Bungalow"], weight: 5 },
    { field: "monthly_spend", equals: "Over €200", weight: 15 },
    { field: "monthly_spend", equals: "€150–€200", weight: 10 },
    { field: "has_solar", equals: "no", weight: 5 },
    { field: "battery_interest", equals: "yes", weight: 10 },
    { field: "has_ev", equals: "yes", weight: 10 },
    { field: "timeframe", equals: "< 3 months", weight: 30 },
    { field: "timeframe", equals: "3–6 months", weight: 15 },
  ],
  tiers: { hot: 60, warm: 35 },
  outcome: {
    onComplete: "route",
    bookingIntent: { field: "ready_for_survey", equals: "yes" },
    sequenceTag: "retrofit-solar-qualified",
  },
};

// ─── Property: buyer ─────────────────────────────────────────────

export const PROPERTY_BUYER: FlowDefinition = {
  id: "property-buyer",
  name: "Property Buyer Qualification",
  vertical: "property",
  description:
    "Qualifies a buyer enquiry: budget band, mortgage AIP, bedrooms, target areas, timeline and first-time-buyer status.",
  triggerKeywords: ["buying", "buyer", "mortgage", "house viewing", "property search"],
  fields: [
    {
      name: "budget_band",
      question: "Thanks for getting in touch! What's your budget range?",
      type: "choice",
      options: ["Under €250k", "€250k–€350k", "€350k–€500k", "Over €500k"],
    },
    {
      name: "mortgage_aip",
      question: "Do you have a mortgage Approval in Principle (AIP) in place?",
      type: "yesno",
    },
    {
      name: "bedrooms",
      question: "How many bedrooms do you need?",
      type: "choice",
      options: BEDROOM_OPTIONS,
    },
    {
      name: "areas",
      question: "Which areas are you looking in?",
      type: "text",
    },
    {
      name: "timeline",
      question: "When are you hoping to buy?",
      type: "choice",
      options: TIMEFRAME_OPTIONS,
    },
    {
      name: "first_time_buyer",
      question: "Are you a first-time buyer?",
      type: "yesno",
    },
  ],
  scoring: [
    { field: "mortgage_aip", equals: "yes", weight: 15 },
    { field: "budget_band", in: ["€350k–€500k", "Over €500k"], weight: 10 },
    { field: "timeline", equals: "< 3 months", weight: 25 },
    { field: "timeline", equals: "3–6 months", weight: 12 },
    { field: "first_time_buyer", equals: "yes", weight: 5 },
  ],
  tiers: { hot: 60, warm: 35 },
  outcome: { onComplete: "tag", sequenceTag: "buyer-qualified" },
};

// ─── Property: seller ────────────────────────────────────────────

export const PROPERTY_SELLER: FlowDefinition = {
  id: "property-seller",
  name: "Property Seller Qualification",
  vertical: "property",
  description:
    "Qualifies a seller enquiry: address, property type, bedrooms, selling timeframe, listing status, reason for moving and valuation interest.",
  triggerKeywords: ["selling", "sell my house", "valuation", "market value", "estate agent"],
  fields: [
    {
      name: "address",
      question: "Thanks for reaching out! What's the property address (or area)?",
      type: "text",
    },
    {
      name: "property_type",
      question: "What type of property is it?",
      type: "choice",
      options: PROPERTY_TYPE_OPTIONS,
    },
    {
      name: "bedrooms",
      question: "How many bedrooms does it have?",
      type: "choice",
      options: BEDROOM_OPTIONS,
    },
    {
      name: "selling_timeframe",
      question: "When are you looking to sell?",
      type: "choice",
      options: ["< 3 months", "3–6 months", "6–12 months", "Not decided yet"],
    },
    {
      name: "already_listed",
      question: "Is the property already listed for sale?",
      type: "yesno",
    },
    {
      name: "reason_for_moving",
      question: "Anything driving the move we should know about?",
      type: "text",
      required: false,
      optionalHint: "optional — reply \"skip\" to move on",
    },
    {
      name: "wants_valuation",
      question: "Would you like a free, no-obligation valuation?",
      type: "yesno",
    },
  ],
  scoring: [
    { field: "selling_timeframe", equals: "< 3 months", weight: 25 },
    { field: "selling_timeframe", equals: "3–6 months", weight: 12 },
    { field: "already_listed", equals: "no", weight: 5 },
    { field: "property_type", in: ["Detached", "Semi-detached", "Bungalow"], weight: 5 },
    { field: "wants_valuation", equals: "yes", weight: 15 },
  ],
  tiers: { hot: 60, warm: 35 },
  outcome: {
    onComplete: "route",
    bookingIntent: { field: "wants_valuation", equals: "yes" },
    sequenceTag: "seller-qualified",
  },
};

// ─── Property: landlord ──────────────────────────────────────────

export const PROPERTY_LANDLORD: FlowDefinition = {
  id: "property-landlord",
  name: "Landlord Qualification",
  vertical: "property",
  description:
    "Qualifies a landlord enquiry: portfolio size, location, current management, rent band, services required and appraisal interest.",
  triggerKeywords: ["landlord", "letting", "rent my property", "property management", "tenant"],
  fields: [
    {
      name: "num_properties",
      question: "Thanks for reaching out! How many properties do you own?",
      type: "choice",
      options: ["1", "2", "3–5", "6+"],
    },
    {
      name: "location",
      question: "Where are the properties located (area or county)?",
      type: "text",
    },
    {
      name: "currently_managed",
      question: "Are any of them currently managed by an agent?",
      type: "yesno",
    },
    {
      name: "current_agent",
      question: "Who manages them at the moment?",
      type: "text",
      required: false,
      optionalHint: "optional — reply \"skip\" to move on",
      skipIf: { field: "currently_managed", equals: "no" },
    },
    {
      name: "rent_band",
      question: "What monthly rent are you achieving (per property)?",
      type: "choice",
      options: ["Under €1,500", "€1,500–€2,000", "€2,000–€2,500", "Over €2,500"],
    },
    {
      name: "services_required",
      question: "What services do you need (lettings, full management, rent collection…)?",
      type: "text",
      required: false,
      optionalHint: "optional — reply \"skip\" to move on",
    },
    {
      name: "wants_appraisal",
      question: "Would you like a free rental appraisal?",
      type: "yesno",
    },
  ],
  scoring: [
    { field: "num_properties", equals: "3–5", weight: 20 },
    { field: "num_properties", equals: "6+", weight: 25 },
    { field: "num_properties", equals: "2", weight: 8 },
    { field: "currently_managed", equals: "no", weight: 10 },
    { field: "rent_band", equals: "Over €2,500", weight: 10 },
    { field: "rent_band", equals: "€2,000–€2,500", weight: 5 },
    { field: "wants_appraisal", equals: "yes", weight: 15 },
  ],
  tiers: { hot: 60, warm: 35 },
  outcome: {
    onComplete: "route",
    bookingIntent: { field: "wants_appraisal", equals: "yes" },
    sequenceTag: "landlord-qualified",
  },
};

/** All code-versioned builtins (seeded idempotently at bootstrap). */
export const BUILTIN_FLOWS: FlowDefinition[] = [
  RETROFIT_SOLAR_QUALIFICATION,
  PROPERTY_BUYER,
  PROPERTY_SELLER,
  PROPERTY_LANDLORD,
];

export const BUILTIN_FLOW_IDS = new Set(BUILTIN_FLOWS.map((f) => f.id));
