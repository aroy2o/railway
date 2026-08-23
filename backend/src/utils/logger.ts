/**
 * Minimal level-aware logger.
 *
 * Deliberately dependency-free: the service needs consistent, filterable log
 * output, not a logging framework. Structured JSON in production (so container
 * logs are greppable), human-readable lines in development.
 */
import { config } from '../config/env.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

/** Arbitrary structured context attached to a log line. */
export type LogMeta = Record<string, unknown>;

const LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};
const threshold = LEVELS[config.logLevel] ?? LEVELS.info;

function emit(level: Exclude<LogLevel, 'silent'>, message: string, meta?: LogMeta): void {
  if (LEVELS[level] < threshold) return;

  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;

  if (config.isProduction) {
    stream.write(
      `${JSON.stringify({ ts: new Date().toISOString(), level, message, ...meta })}\n`,
    );
    return;
  }

  const suffix = meta && Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  stream.write(`[${level.toUpperCase()}] ${message}${suffix}\n`);
}

export const logger = {
  debug: (message: string, meta?: LogMeta): void => emit('debug', message, meta),
  info: (message: string, meta?: LogMeta): void => emit('info', message, meta),
  warn: (message: string, meta?: LogMeta): void => emit('warn', message, meta),
  error: (message: string, meta?: LogMeta): void => emit('error', message, meta),
};

export default logger;
