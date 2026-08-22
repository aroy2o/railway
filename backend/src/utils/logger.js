/**
 * Minimal level-aware logger.
 *
 * Deliberately dependency-free: the service needs consistent, filterable log
 * output, not a logging framework. Structured JSON in production (so container
 * logs are greppable), human-readable lines in development.
 */
import { config } from '../config/env.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
const threshold = LEVELS[config.logLevel] ?? LEVELS.info;

function emit(level, message, meta) {
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
  debug: (message, meta) => emit('debug', message, meta),
  info: (message, meta) => emit('info', message, meta),
  warn: (message, meta) => emit('warn', message, meta),
  error: (message, meta) => emit('error', message, meta),
};

export default logger;
