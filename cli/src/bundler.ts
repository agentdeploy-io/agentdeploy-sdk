// ── AgentDeploy CLI — Bundler (esbuild wrapper) ──────────────────────────────

import { build } from "esbuild";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

export interface BundleResult {
  /** Bundled ESM output */
  code: string;
  /** Source map (if generated) */
  map?: string;
  /** Any warnings from esbuild */
  warnings: string[];
  /** Size of output in bytes */
  sizeBytes: number;
}

export interface BundleOptions {
  /** Project root directory */
  projectRoot: string;
  /** Entrypoint file (relative to projectRoot) */
  entrypoint: string;
  /** Whether to generate a source map */
  sourcemap?: boolean;
  /** External packages to exclude from bundling */
  external?: string[];
  /** Minify output */
  minify?: boolean;
}

// Packages that should NOT be bundled — they're either provided by the Workers
// runtime or injected by the platform at deploy time.
const WORKERS_EXTERNAL = [
  "cloudflare:workers",
  "cloudflare:sockets",
  "cloudflare:api_compatibility",
];

const PLATFORM_EXTERNAL = [
  // These are injected by the AgentDeploy platform renderer as ambient globals
  // (AD_DEPLOYMENT_ID, AD_GATEWAY_BASE_URL, etc.)
];

/**
 * Bundle an AgentDeploy edge agent project into a single ESM module using esbuild.
 *
 * This output is what gets uploaded to the platform. The platform then wraps it
 * with AD_* ambient constants and deploys as a Cloudflare Worker.
 */
export async function bundleAgent(opts: BundleOptions): Promise<BundleResult> {
  const entryPath = resolve(opts.projectRoot, opts.entrypoint);

  if (!existsSync(entryPath)) {
    throw new Error(`Entrypoint not found: ${entryPath}`);
  }

  // Load tsconfig if present for path resolution
  const tsconfigPath = join(opts.projectRoot, "tsconfig.json");
  const tsconfig = existsSync(tsconfigPath)
    ? JSON.parse(readFileSync(tsconfigPath, "utf-8"))
    : undefined;

  const external = [...WORKERS_EXTERNAL, ...PLATFORM_EXTERNAL, ...(opts.external || [])];

  const result = await build({
    entryPoints: [entryPath],
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    outfile: "", // We want stdout output
    write: false,
    sourcemap: opts.sourcemap ? "external" : false,
    minify: opts.minify ?? true,
    minifyIdentifiers: true,
    minifySyntax: true,
    minifyWhitespace: true,
    legalComments: "none",
    treeShaking: true,
    splitting: false,
    metafile: false,
    logLevel: "warning",
    tsconfig: tsconfig ? tsconfigPath : undefined,
    external,
    conditions: ["workerd", "browser", "import", "default"],
    mainFields: ["module", "main"],
    banner: {
      js: [
        "// ── AgentDeploy Edge Agent — Auto-bundled by @agentdeploy/cli ──",
        "// This module was bundled from TypeScript using esbuild.",
        "// Platform ambient constants (AD_*) are injected at deploy time.",
        "",
      ].join("\n"),
    },
  });

  const code = result.outputFiles?.[0]?.text;
  if (!code) {
    throw new Error("esbuild produced no output");
  }

  const map = result.outputFiles?.[1]?.text;

  const warnings = result.warnings.map((w) => w.text);

  return {
    code,
    map,
    warnings,
    sizeBytes: Buffer.byteLength(code, "utf-8"),
  };
}

/**
 * Format byte size for human-readable display.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
