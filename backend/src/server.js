/**
 * Process entry point: connect the database, bind the port, shut down cleanly.
 */
import { createApp } from './app.js';
import { config } from './config/env.js';
import { connectDatabase, disconnectDatabase } from './config/db.js';
import { logger } from './utils/logger.js';

async function main() {
  await connectDatabase();

  const app = createApp();
  const server = app.listen(config.port, () => {
    logger.info('Backend API listening', {
      port: config.port,
      env: config.env,
      optimizerUrl: config.optimizer.baseUrl,
    });
  });

  installShutdownHandlers(server);
}

function installShutdownHandlers(server) {
  let shuttingDown = false;

  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Shutting down', { signal });

    // Stop accepting new connections, then drain the database handle. If a
    // request hangs, the timer below still guarantees the process exits.
    const forceExit = setTimeout(() => {
      logger.error('Shutdown timed out, forcing exit');
      process.exit(1);
    }, 10_000);
    forceExit.unref();

    server.close(async (err) => {
      if (err) logger.error('Error closing HTTP server', { message: err.message });
      try {
        await disconnectDatabase();
      } catch (closeErr) {
        logger.error('Error closing database', { message: closeErr.message });
      }
      process.exit(err ? 1 : 0);
    });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // An unhandled rejection leaves the process in an unknown state; log it with
  // full context and exit rather than continuing to serve traffic blindly.
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection', {
      message: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
    process.exit(1);
  });
}

main().catch((err) => {
  logger.error('Fatal error during startup', { message: err.message, stack: err.stack });
  process.exit(1);
});
