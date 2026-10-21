export { normalizeName, getDistinctiveFragment } from "./normalize.js";
export {
  discoverCandidates,
  braveSearch,
  DIRECTORY_DOMAINS,
} from "./discovery.js";
export { verify } from "./verification.js";
export type { PageContent, RegistryInfo } from "./verification.js";
export {
  computeVerdict,
  makeSignal,
  SIGNAL_WEIGHTS,
  SIGNAL_NAMES,
} from "./scoring.js";
export {
  extractContacts,
  extractEmails,
  extractPhones,
  extractSocials,
  decodeCfEmail,
  checkMx,
  validateMxRecords,
  parseSitemap,
  findContactUrls,
  CONTACT_PATHS,
} from "./extraction.js";
export type {
  WebsiteStatus,
  CandidateResult,
  NormalizedName,
  VerificationSignal,
  VerificationResult,
  ContactExtraction,
  ExtractedEmail,
  BraveSearchResult,
  BraveOpts,
} from "./types.js";

export { mastra, crawlerAgent, crawlWorkflow } from "./mastra/index.js";
