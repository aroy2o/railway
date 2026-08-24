/**
 * Typed, validated configuration for the Express API.
 *
 * Every tunable value in this service comes from here - there are no hardcoded
 * ports, URLs, secrets or timeouts anywhere else in the codebase. The process
 * refuses to boot on invalid config rather than starting in a half-broken
 * state, so a misconfiguration surfaces immediately at deploy time instead of
 * as a confusing 500 during the demo.
 *
 * Precedence (highest first):
 *   1. real process environment (what docker-compose injects)
 *   2. backend/.env          - service-local override, optional
 *   3. <repo root>/.env      - the shared file documented in .env.example
 * See docs/DECISIONS.md D-002.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';

const here = path.dirname(fileURLToPath(import.meta.url));
/** Resolves from src/config at dev time and dist/config after a build. */
const BACKEND_ROOT = path.resolve(here, '..', '..');
const REPO_ROOT = path.resolve(BACKEND_ROOT, '..');

// dotenv does not overwrite variables that are already set, so loading the
// service-local file first is what gives it precedence over the shared one.
dotenv.config({ path: path.join(BACKEND_ROOT, '.env'), quiet: true });
dotenv.config({ path: path.join(REPO_ROOT, '.env'), quiet: true });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),

  BACKEND_PORT: z.coerce.number().int().min(1).max(65535).default(5000),
  MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),

  // Comma-separated browser origins allowed to call this API.
  CORS_ORIGIN: z.string().default('http://localhost:5173'),

  // FR10.2 - JWT auth. Short secrets are rejected outright; a weak signing key
  // is a silent security hole rather than a loud failure, so we make it loud.
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  JWT_EXPIRES_IN: z.string().min(1).default('12h'),

  // The Python CP-SAT service. Node never runs OR-Tools itself.
  OPTIMIZER_URL: z.url('OPTIMIZER_URL must be a valid URL'),
  OPTIMIZER_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  // Ask the Planner waits on a Claude API call, not a CP-SAT solve, so it gets
  // its own budget. Sharing the solver's 30s would either cut off a slow
  // generation or make a hung LLM call hold a request far too long.
  EXPLAIN_TIMEOUT_MS: z.coerce.number().int().positive().default(60000),
  // T20: up to 4 real CP-SAT solves in one request (baseline + MAX_OPTIONS).
  // Each is capped at the optimizer's own WHATIF_SOLVER_MAX_SECONDS (4s
  // default), so the worst case is ~16s of solving plus network overhead -
  // 45s leaves comfortable headroom without inheriting /optimize's 30s
  // budget, which was sized for exactly one solve.
  WHATIF_TIMEOUT_MS: z.coerce.number().int().positive().default(45000),

  // Where the seed script reads the pipeline output from. Relative paths are
  // resolved against the repo root, so the default works from any cwd.
  DATA_PROCESSED_DIR: z.string().default('data/processed'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
  // Deliberately console.error + exit rather than throwing: this runs at import
  // time, and a raw stack trace here is far less useful than the list of vars.
  console.error(
    `Invalid environment configuration.\n${details}\n\n` +
      `Copy .env.example to .env at the repo root and fill in the values above.`,
  );
  process.exit(1);
}

const raw = parsed.data;

export interface AppConfig {
  readonly env: 'development' | 'test' | 'production';
  readonly isProduction: boolean;
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error' | 'silent';
  readonly port: number;
  readonly mongoUri: string;
  readonly corsOrigins: readonly string[];
  readonly jwt: { readonly secret: string; readonly expiresIn: string };
  readonly optimizer: {
    readonly baseUrl: string;
    readonly timeoutMs: number;
    readonly explainTimeoutMs: number;
    readonly whatIfTimeoutMs: number;
  };
  readonly paths: { readonly repoRoot: string; readonly processedData: string };
}

export const config: AppConfig = Object.freeze({
  env: raw.NODE_ENV,
  isProduction: raw.NODE_ENV === 'production',
  logLevel: raw.LOG_LEVEL,
  port: raw.BACKEND_PORT,
  mongoUri: raw.MONGODB_URI,
  corsOrigins: raw.CORS_ORIGIN.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  jwt: Object.freeze({
    secret: raw.JWT_SECRET,
    expiresIn: raw.JWT_EXPIRES_IN,
  }),
  optimizer: Object.freeze({
    baseUrl: raw.OPTIMIZER_URL.replace(/\/+$/, ''),
    timeoutMs: raw.OPTIMIZER_TIMEOUT_MS,
    explainTimeoutMs: raw.EXPLAIN_TIMEOUT_MS,
    whatIfTimeoutMs: raw.WHATIF_TIMEOUT_MS,
  }),
  paths: Object.freeze({
    repoRoot: REPO_ROOT,
    processedData: path.isAbsolute(raw.DATA_PROCESSED_DIR)
      ? raw.DATA_PROCESSED_DIR
      : path.join(REPO_ROOT, raw.DATA_PROCESSED_DIR),
  }),
});

export default config;
