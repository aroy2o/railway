/**
 * MongoDB connection lifecycle.
 *
 * Collection schemas themselves are task T5 - this module only owns connecting,
 * reporting connection health, and shutting down cleanly.
 *
 * The API refuses to start if Mongo is unreachable. That is deliberate: a
 * server that boots and then 500s on every data route is much harder to
 * diagnose mid-demo than one that never came up with a clear reason.
 */
import mongoose from 'mongoose';
import { config } from './env.js';
import { logger } from '../utils/logger.js';

// Fail fast instead of letting Mongoose buffer queries for 30s against a
// connection that was never established.
mongoose.set('bufferCommands', false);
mongoose.set('strictQuery', true);

export async function connectDatabase() {
  mongoose.connection.on('disconnected', () => {
    logger.warn('MongoDB disconnected');
  });
  mongoose.connection.on('reconnected', () => {
    logger.info('MongoDB reconnected');
  });
  // Post-handshake errors do not reject the initial connect() promise, so they
  // need their own listener or they surface as an unhandled rejection.
  mongoose.connection.on('error', (err) => {
    logger.error('MongoDB connection error', { message: err.message });
  });

  await mongoose.connect(config.mongoUri, {
    serverSelectionTimeoutMS: 5000,
  });

  logger.info('MongoDB connected', { database: mongoose.connection.name });
  return mongoose.connection;
}

export async function disconnectDatabase() {
  await mongoose.connection.close();
  logger.info('MongoDB connection closed');
}

/**
 * Readiness signal for GET /health. Mirrors mongoose.STATES; 1 === connected.
 */
export function databaseStatus() {
  const states = ['disconnected', 'connected', 'connecting', 'disconnecting', 'uninitialized'];
  return {
    connected: mongoose.connection.readyState === 1,
    state: states[mongoose.connection.readyState] ?? 'unknown',
  };
}
