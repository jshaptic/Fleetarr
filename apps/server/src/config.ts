import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSecret } from './lib/crypto.js';

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface AppConfig {
  readonly appVersion: string;
  readonly host: string;
  readonly port: number;
  readonly configDir: string;
  readonly databaseFile: string;
  readonly migrationsDir: string;
  readonly webRoot: string;
  readonly logLevel: LogLevel;
  readonly trustProxy: boolean;
  readonly corsOrigins: readonly string[];
  /**
   * Storage roots Fleetarr may inspect and modify, colon-separated like PATH. Empty
   * disables every filesystem operation. These must be the same paths the *Arr containers
   * see - Fleetarr deliberately has no path translation layer.
   */
  readonly fsRoots: readonly string[];
  /**
   * A filesystem with less than this much free space is reported as low.
   *
   * Deliberately separate from the 1 GiB `LOW_SPACE_BYTES` in the filesystem service: that
   * answers "will this mkdir or move succeed", this answers "is this library filling up".
   * Unifying them would make one of the two wrong.
   */
  readonly lowSpaceBytes: number;
  /**
   * A filesystem with less than this percentage free is reported as low, OR'd with the
   * byte floor above. Zero - the default - disables the ratio.
   *
   * Off by default because a ratio is loud on a large array: 10% of a 50 TB array is 5 TB,
   * which still holds fifty 4K films. The byte floor is the rule that is right at every
   * disk size; the ratio is for people who know their own headroom.
   */
  readonly lowSpacePercent: number;
  /** Used to derive the AES key for stored *Arr API keys. Never log this. */
  readonly secret: string;
}

/** 50 GiB - roughly one 4K remux plus margin, so the warning means "the next import may not fit". */
const DEFAULT_LOW_SPACE_BYTES = 50 * 1024 ** 3;

const BYTE_UNITS: Readonly<Record<string, number>> = {
  b: 1,
  k: 1024,
  kb: 1024,
  kib: 1024,
  m: 1024 ** 2,
  mb: 1024 ** 2,
  mib: 1024 ** 2,
  g: 1024 ** 3,
  gb: 1024 ** 3,
  gib: 1024 ** 3,
  t: 1024 ** 4,
  tb: 1024 ** 4,
  tib: 1024 ** 4,
  p: 1024 ** 5,
  pb: 1024 ** 5,
  pib: 1024 ** 5,
};

export interface LowSpaceThresholds {
  readonly bytes: number;
  readonly percent: number;
}

/**
 * Is this filesystem low on space?
 *
 * Pure and exported so the rule can be tested without a filesystem, and so the server and
 * the tests can never disagree about what "low" means.
 */
export function isLowSpace(
  freeSpace: number | null,
  totalSpace: number | null,
  thresholds: LowSpaceThresholds,
): boolean {
  if (freeSpace === null) return false;
  if (thresholds.bytes > 0 && freeSpace < thresholds.bytes) return true;
  if (thresholds.percent <= 0 || totalSpace === null || totalSpace <= 0) return false;
  return freeSpace / totalSpace < thresholds.percent / 100;
}

/**
 * Both `src/` (tsx dev) and `dist/` (built) sit one level below apps/server, so
 * these relative resolutions hold in development and inside the container alike.
 */
function fromServerRoot(relative: string): string {
  return fileURLToPath(new URL(relative, import.meta.url));
}

/**
 * Last cut release, from the repo-root package.json. CI overlays a hashed
 * `APP_VERSION` (e.g. `0.1.0-dev.abc1234`) at image build time; that env wins.
 */
function readPackageVersion(): string {
  const pkgPath = fromServerRoot('../../../package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { readonly version?: unknown };
  if (typeof pkg.version !== 'string' || pkg.version.length === 0) {
    throw new Error(`package.json at ${pkgPath} has no version`);
  }
  return pkg.version;
}

function envString(key: string): string | undefined {
  const value = process.env[key];
  return value === undefined || value.trim() === '' ? undefined : value.trim();
}

function envInt(key: string, fallback: number): number {
  const raw = envString(key);
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Environment variable ${key} must be an integer, got "${raw}"`);
  }
  return parsed;
}

/**
 * A byte count, optionally with a unit: `50G`, `50GiB`, `500M`, or a plain number. The
 * audience writes docker-compose files, where `53687091200` is an invitation to be off by
 * a factor of 1024.
 */
function envBytes(key: string, fallback: number): number {
  const raw = envString(key);
  if (raw === undefined) return fallback;

  const match = /^(\d+(?:\.\d+)?)\s*([a-zA-Z]*)$/.exec(raw);
  const unit = match === null ? undefined : BYTE_UNITS[(match[2] ?? '').toLowerCase() || 'b'];
  if (match === null || unit === undefined) {
    throw new Error(
      `Environment variable ${key} must be a byte count such as 50G, 500MiB or 1073741824, got "${raw}"`,
    );
  }
  return Math.floor(Number(match[1]) * unit);
}

function envBool(key: string, fallback: boolean): boolean {
  const raw = envString(key)?.toLowerCase();
  if (raw === undefined) return fallback;
  return raw === '1' || raw === 'true' || raw === 'yes';
}

function envLogLevel(fallback: LogLevel): LogLevel {
  const raw = envString('LOG_LEVEL')?.toLowerCase();
  if (raw === undefined) return fallback;
  const match = LOG_LEVELS.find((level) => level === raw);
  if (!match) {
    throw new Error(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}, got "${raw}"`);
  }
  return match;
}

export function loadConfig(): AppConfig {
  // Container default is /config (the Unraid appdata volume). Dev falls back to a
  // gitignored folder at the repo root - resolved from this file rather than cwd, so
  // `npm run dev` (cwd apps/server) and `npm start` (cwd repo root) share one database.
  const configDir = path.resolve(envString('CONFIG_DIR') ?? fromServerRoot('../../../.config-dev'));
  mkdirSync(configDir, { recursive: true });

  const config: AppConfig = {
    appVersion: envString('APP_VERSION') ?? readPackageVersion(),
    host: envString('HOST') ?? '0.0.0.0',
    port: envInt('PORT', 8586),
    configDir,
    databaseFile: path.join(configDir, 'fleetarr.db'),
    migrationsDir: envString('MIGRATIONS_DIR') ?? fromServerRoot('../migrations/'),
    webRoot: envString('WEB_ROOT') ?? fromServerRoot('../../web/dist/'),
    logLevel: envLogLevel('info'),
    trustProxy: envBool('TRUST_PROXY', false),
    corsOrigins: (envString('CORS_ORIGINS') ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
    fsRoots: (envString('FS_ROOTS') ?? '')
      .split(':')
      .map((root) => root.trim())
      .filter((root) => root.length > 0),
    lowSpaceBytes: envBytes('FS_LOW_SPACE_BYTES', DEFAULT_LOW_SPACE_BYTES),
    lowSpacePercent: envInt('FS_LOW_SPACE_PERCENT', 0),
    secret: resolveSecret(envString('FLEETARR_SECRET'), path.join(configDir, 'secret.key')),
  };

  return Object.freeze(config);
}
