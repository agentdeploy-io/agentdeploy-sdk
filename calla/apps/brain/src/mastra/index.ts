import { Mastra } from "@mastra/core";
import { PostgresStore } from "@mastra/pg";
import { LibSQLStore } from "@mastra/libsql";
import {
  Observability,
  MastraStorageExporter,
  SensitiveDataFilter,
} from "@mastra/observability";
import { orchestratorAgent } from "./agents/orchestrator.js";
import { approvalWithEscalation } from "./workflows/approval-with-escalation.js";

export type StorageKind = "pg" | "libsql";

const DATABASE_URL = process.env.DATABASE_URL;

/** Which storage backend is active — surfaced by GET /health. */
export const storageKind: StorageKind = DATABASE_URL ? "pg" : "libsql";

/**
 * Postgres when DATABASE_URL is set (Fly.io production); otherwise a local
 * LibSQL file so the brain boots with zero infrastructure (dev / smoke).
 */
function createStorage() {
  if (DATABASE_URL) {
    return new PostgresStore({
      id: "calla-brain-pg",
      connectionString: DATABASE_URL,
    });
  }
  return new LibSQLStore({
    id: "calla-brain-libsql",
    url: process.env.LIBSQL_URL ?? "file:local.db",
  });
}

export const storage = createStorage();

export const agents = { orchestratorAgent };

/**
 * Observability — pattern adopted from chrislema/mastra-builder:
 * traces/logs/scoring events persist into Mastra storage (queryable, survive
 * restarts) with sensitive-data redaction on span output. Set
 * MASTRA_PLATFORM_ACCESS_TOKEN + import MastraPlatformExporter to also ship
 * events to Mastra Platform.
 */
const observability = new Observability({
  configs: {
    default: {
      serviceName: process.env.CALLA_OTEL_SERVICE_NAME ?? "calla-brain",
      exporters: [new MastraStorageExporter()],
      spanOutputProcessors: [new SensitiveDataFilter()],
    },
  },
});

export const mastra = new Mastra({
  agents,
  workflows: { approvalWithEscalation },
  storage,
  observability,
});
