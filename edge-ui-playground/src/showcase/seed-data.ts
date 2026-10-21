const FIRST_NAMES = [
  "James", "Sarah", "Michael", "Emma", "David", "Laura", "Robert", "Catherine",
  "Thomas", "Helen", "Andrew", "Rachel", "John", "Fiona", "Patrick", "Siobhan",
  "Declan", "Aoife", "Conor", "Niamh", "Pierre", "Marie", "Jean", "Sophie",
  "Philippe", "Claire", "Antoine", "Isabelle", "Laurent", "Camille",
];

const LAST_NAMES = [
  "Walsh", "Murphy", "O'Brien", "Kelly", "O'Sullivan", "Ryan", "Byrne", "Doyle",
  "Fitzgerald", "Nolan", "Brennan", "Hayes", "Murray", "Collins", "Cunningham",
  "Duffy", "Quinn", "Gallagher", "Doherty", "Kennedy", "Thompson", "Campbell",
  "Wilson", "Stewart", "Anderson", "Dubois", "Laurent", "Bernard", "Petit", "Moreau",
];

const UK_COMPANIES = [
  "Hartwell & Associates", "Pemberton Chartered", "Kingsley Advisory", "Ashford Partners LLP",
  "Beaumont Legal Services", "Cranfield & Co", "Whitmore Consulting", "Blackwell Tax Advisory",
  "Ridgeway Financial", "Langford & Blake", "Thornton Associates", "Ellis Hartley LLP",
  "Chadwick Moore", "Preston Wells", "Fairfield Advisory", "Kensington Bridge Ltd",
  "Halstead & Partners", "Ashworth Green", "Wexford Stanley", "Caldwell Ross",
];

const IE_COMPANIES = [
  "Fitzpatrick & Sons", "Murphy Keane Legal", "Shannon Partners", "Galway Bay Consulting",
  "O'Malley Accountants", "Kildare Financial", "Liffey Advisory Group", "Dingle Peninsula Ltd",
  "Cork Street Partners", "Burren Legal LLP", "Killarney Advisory", "Aran Consulting",
  "Claddagh Financial", "Merrion Square Partners", "Griffith & Co", "Howth Advisory",
];

const FR_COMPANIES = [
  "Cabinet Laurent", "Moreau & Associes", "Bernard Conseil", "Dubois Expertise",
  "Petit et Fils", "Garnier Associés", "Roux Consulting", "Fournier Audit",
  "Girard & Partners", "Lefevre Conseils",
];

const SIC_CODES_INCLUDED = [
  "69101", "69102", "69201", "69202", "69203", "70229", "71111", "71112",
  "86210", "86220", "86900", "64110", "64191", "66190", "65120",
];

const STAGES = ["raw", "verified", "classified", "researched", "approved", "sent", "replied"] as const;
const STAGE_COUNTS: Record<string, number> = {
  raw: 50, verified: 30, classified: 25, researched: 20, approved: 15, sent: 10, replied: 5,
};

const TIERS = ["HOT", "WARM", "COLD", "SKIP"] as const;
const TIER_WEIGHTS = [0.15, 0.35, 0.40, 0.10];

const COUNTRIES = ["UK", "IE", "FR"] as const;
const COUNTRY_WEIGHTS = [0.60, 0.25, 0.15];

function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 16807 + 0) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

function weightedPick<T>(items: readonly T[], weights: number[], rng: () => number): T {
  const r = rng();
  let cumulative = 0;
  for (let i = 0; i < items.length; i++) {
    cumulative += weights[i];
    if (r < cumulative) return items[i];
  }
  return items[items.length - 1];
}

function daysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(Math.floor(Math.random() * 14) + 8, Math.floor(Math.random() * 60), 0, 0);
  return d.toISOString();
}

function generateEmail(first: string, last: string, company: string, rng: () => number): string {
  const domains = ["gmail.com", "outlook.com", "company.co.uk", "mail.ie", "wanadoo.fr"];
  const sep = rng() > 0.5 ? "." : "";
  const domain = company.toLowerCase().replace(/[^a-z]/g, "").slice(0, 12);
  const useCompanyDomain = rng() > 0.4;
  return `${first.toLowerCase()}${sep}${last.toLowerCase()}@${useCompanyDomain ? domain + ".co.uk" : domains[Math.floor(rng() * domains.length)]}`;
}

export interface SeedLead {
  email: string;
  name: string;
  company: string;
  stage: string;
  status: string;
  country: string;
  website: string;
  website_status: string;
  tier: string;
  source: string;
  created_at: string;
  updated_at: string;
  classification: { sic_code: string; sector: string } | null;
  website_evidence: { snippet: string; has_contact: boolean; has_services: boolean } | null;
  note: string | null;
  reply_draft?: string;
}

export interface SeedCrawlRun {
  id: string;
  trigger: string;
  startedAt: string;
  duration: number;
  vmMinutes: number;
  tokens: number;
  cost: number;
  state: string;
  leadsFound: number;
  leadsNew: number;
}

export interface SeedResearchBatch {
  id: string;
  batchDate: string;
  leadCount: number;
  completedCount: number;
  failedCount: number;
  avgLatencyMs: number;
}

export interface SeedReplyDraft {
  email: string;
  name: string;
  company: string;
  reply_draft: string;
  last_message: string;
  stage: string;
  status: string;
}

export interface SeedFlaggedWebsite {
  email: string;
  name: string;
  website: string;
  website_status: string;
  website_evidence: Record<string, unknown>;
}

export interface SeedDataset {
  leads: SeedLead[];
  crawlRuns: SeedCrawlRun[];
  researchBatches: SeedResearchBatch[];
  replyDrafts: SeedReplyDraft[];
  flaggedWebsites: SeedFlaggedWebsite[];
  pipelineStages: { name: string; count: number; delta24h: number }[];
}

export function generateSeedData(): SeedDataset {
  const rng = seededRandom(42);
  const leads: SeedLead[] = [];

  let idx = 0;
  for (const stage of STAGES) {
    const count = STAGE_COUNTS[stage];
    for (let i = 0; i < count; i++) {
      const country = weightedPick(COUNTRIES, COUNTRY_WEIGHTS, rng);
      const tier = weightedPick(TIERS, TIER_WEIGHTS, rng);
      const first = FIRST_NAMES[Math.floor(rng() * FIRST_NAMES.length)];
      const last = LAST_NAMES[Math.floor(rng() * LAST_NAMES.length)];

      let company: string;
      if (country === "UK") company = UK_COMPANIES[Math.floor(rng() * UK_COMPANIES.length)];
      else if (country === "IE") company = IE_COMPANIES[Math.floor(rng() * IE_COMPANIES.length)];
      else company = FR_COMPANIES[Math.floor(rng() * FR_COMPANIES.length)];

      const email = generateEmail(first, last, company, rng);
      const domain = company.toLowerCase().replace(/[^a-z]/g, "").slice(0, 12);
      const createdDaysAgo = Math.floor(rng() * 10) + 1;
      const updatedDaysAgo = Math.max(0, createdDaysAgo - Math.floor(rng() * 3));

      const stageIdx = STAGES.indexOf(stage);
      const hasClassification = stageIdx >= 2;
      const hasEvidence = stageIdx >= 3;

      const statusMap: Record<string, string> = {
        raw: "pending",
        verified: "pending",
        classified: "pending_review",
        researched: "pending_review",
        approved: "approved",
        sent: "active",
        replied: "active",
      };

      const webStatuses = ["reachable", "unreachable", "timeout", "pending"];
      const webStatus = hasEvidence
        ? webStatuses[Math.floor(rng() * 2)]
        : stageIdx >= 1 ? "reachable" : "pending";

      const lead: SeedLead = {
        email,
        name: `${first} ${last}`,
        company,
        stage,
        status: statusMap[stage] || "pending",
        country,
        website: `https://www.${domain}.co.uk`,
        website_status: webStatus,
        tier,
        source: ["crawl", "import", "manual", "api"][Math.floor(rng() * 4)],
        created_at: daysAgo(createdDaysAgo),
        updated_at: daysAgo(updatedDaysAgo),
        classification: hasClassification
          ? {
              sic_code: SIC_CODES_INCLUDED[Math.floor(rng() * SIC_CODES_INCLUDED.length)],
              sector: ["Legal", "Accounting", "Tax Advisory", "Healthcare", "Financial Services"][Math.floor(rng() * 5)],
            }
          : null,
        website_evidence: hasEvidence
          ? {
              snippet: [
                "Offers professional services in accounting, tax planning, and business advisory.",
                "Law firm specialising in commercial litigation, property law, and employment law.",
                "Healthcare clinic providing GP services, diagnostics, and specialist consultations.",
                "Chartered accountants offering audit, taxation, and business advisory services.",
                "Legal practice with expertise in corporate law, family law, and conveyancing.",
              ][Math.floor(rng() * 5)],
              has_contact: rng() > 0.2,
              has_services: rng() > 0.3,
            }
          : null,
        note: rng() > 0.7 ? "Flagged for follow-up after initial research." : null,
      };

      leads.push(lead);
      idx++;
    }
  }

  const crawlRuns: SeedCrawlRun[] = [
    {
      id: "crawl-001",
      trigger: "cron",
      startedAt: daysAgo(8),
      duration: 342000,
      vmMinutes: 5.7,
      tokens: 184200,
      cost: 0.0847,
      state: "completed",
      leadsFound: 82,
      leadsNew: 54,
    },
    {
      id: "crawl-002",
      trigger: "cron",
      startedAt: daysAgo(5),
      duration: 288000,
      vmMinutes: 4.8,
      tokens: 156800,
      cost: 0.0721,
      state: "completed",
      leadsFound: 67,
      leadsNew: 38,
    },
    {
      id: "crawl-003",
      trigger: "manual",
      startedAt: daysAgo(2),
      duration: 401000,
      vmMinutes: 6.7,
      tokens: 213400,
      cost: 0.0983,
      state: "completed",
      leadsFound: 95,
      leadsNew: 61,
    },
  ];

  const researchBatches: SeedResearchBatch[] = [];
  for (let i = 0; i < 5; i++) {
    researchBatches.push({
      id: `batch-${String(i + 1).padStart(3, "0")}`,
      batchDate: daysAgo(10 - i * 2),
      leadCount: 15 + Math.floor(rng() * 20),
      completedCount: 12 + Math.floor(rng() * 18),
      failedCount: Math.floor(rng() * 4),
      avgLatencyMs: 2200 + Math.floor(rng() * 3000),
    });
  }

  const replyDrafts: SeedReplyDraft[] = [
    {
      email: "sarah.walsh@pemberton.co.uk",
      name: "Sarah Walsh",
      company: "Pemberton Chartered",
      reply_draft: "Hi Sarah, thank you for your interest in our platform. I'd love to schedule a 15-minute call to walk through how we've helped similar chartered accountants automate their client onboarding. Would Thursday at 2pm work for you?",
      last_message: "Thanks for reaching out — I'd like to understand how this could integrate with our existing practice management software.",
      stage: "sent",
      status: "pending",
    },
    {
      email: "declan.obrien@murphykeane.ie",
      name: "Declan O'Brien",
      company: "Murphy Keane Legal",
      reply_draft: "Hi Declan, great to hear back from you. We've worked with several Irish law firms on exactly this — reducing manual intake time by 60%. I can share a case study from a Dublin-based practice if that's helpful. Happy to jump on a quick call this week.",
      last_message: "Interesting — can you share how this works for firms of our size? We have about 15 solicitors.",
      stage: "sent",
      status: "pending",
    },
  ];

  const flaggedWebsites: SeedFlaggedWebsite[] = [
    {
      email: "pierre.dubois@cabinetlaurent.fr",
      name: "Pierre Dubois",
      website: "https://www.cabinetlaurent.fr",
      website_status: "unreachable",
      website_evidence: {
        http_status: 503,
        checked_at: daysAgo(3),
        retries: 3,
        ssl_valid: false,
        dns_resolves: true,
        redirect_url: null,
      },
    },
    {
      email: "fiona.gallagher@claddaghfinancial.ie",
      name: "Fiona Gallagher",
      website: "https://www.claddaghfinancial.ie",
      website_status: "timeout",
      website_evidence: {
        http_status: null,
        checked_at: daysAgo(2),
        retries: 3,
        ssl_valid: true,
        dns_resolves: true,
        timeout_ms: 15000,
      },
    },
    {
      email: "thomas.kennedy@burrenlegal.ie",
      name: "Thomas Kennedy",
      website: "https://www.burrenlegalllp.com",
      website_status: "unreachable",
      website_evidence: {
        http_status: 404,
        checked_at: daysAgo(1),
        retries: 2,
        ssl_valid: true,
        dns_resolves: true,
        redirect_url: "https://www.burrenlegal.ie/new-site",
      },
    },
  ];

  const pipelineStages = STAGES.map((name) => ({
    name,
    count: STAGE_COUNTS[name],
    delta24h: name === "raw" ? 12 : name === "verified" ? 8 : name === "classified" ? 5 : name === "researched" ? 3 : name === "approved" ? 2 : name === "sent" ? 1 : 0,
  }));

  return {
    leads,
    crawlRuns,
    researchBatches,
    replyDrafts,
    flaggedWebsites,
    pipelineStages,
  };
}
