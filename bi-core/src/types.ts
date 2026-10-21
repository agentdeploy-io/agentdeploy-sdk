export type WebsiteStatus =
  | "candidate"
  | "verified"
  | "flagged"
  | "rejected";

export interface CandidateResult {
  url: string;
  title: string;
  description: string;
  website_status: WebsiteStatus;
}

export interface NormalizedName {
  normalized: string;
  fragment: string;
}

export interface VerificationSignal {
  id: number;
  name: string;
  weight: number;
  fired: boolean;
  snippet: string;
}

export interface VerificationResult {
  url: string;
  score: number;
  signals: VerificationSignal[];
  verdict: "verified" | "flagged" | "rejected";
}

export interface ContactExtraction {
  emails: ExtractedEmail[];
  phones: string[];
  socials: Record<string, string[]>;
  pages: string[];
}

export interface ExtractedEmail {
  address: string;
  kind: "role" | "personal";
  mx_ok: boolean | null;
}

export interface BraveSearchResult {
  title: string;
  url: string;
  description: string;
}

export interface BraveOpts {
  apiKey: string;
  country?: string;
}
