import { envAny } from '../config/index.js';
/**
 * Daemon entrypoint. Run on the inference host, next to the runners:
 *
 *   reviewpassd --port 8787 --db /var/lib/reviewpass/reviewpass.db
 */
import { createDaemon } from './daemon.js';

const argv = process.argv.slice(2);
const arg = (name: string, dflt: string): string => {
  const i = argv.indexOf(`--${name}`);
  const v = i >= 0 ? argv[i + 1] : undefined;
  return v && !v.startsWith('--') ? v : dflt;
};

const opts = {
  // Bound to loopback by default: the runners are on this machine, and the
  // daemon holds a GitHub token per request.
  host: envAny('HOST') ?? arg('host', '127.0.0.1'),
  port: Number(envAny('PORT') ?? arg('port', '8787')),
  dbPath: envAny('DB') ?? arg('db', '/var/lib/reviewpass/reviewpass.db'),
  mirrorRoot: envAny('MIRRORS') ?? arg('mirrors', '/var/lib/reviewpass/mirrors'),
  workRoot: envAny('WORK') ?? arg('work', '/var/lib/reviewpass/work'),
  authToken: envAny('TOKEN'),
  // The model serves one slot, so reviewing two PRs at once only queues work.
  concurrency: Number(envAny('JOBS') ?? arg('jobs', '1')),
};

const daemon = createDaemon(opts);

// Wrapped rather than top-level await: the daemon bundles to CJS so it can keep
// better-sqlite3 as a real native require.
async function start(): Promise<void> {
  await daemon.listen();
  console.log(
    `reviewpassd listening on http://${opts.host}:${opts.port}\n` +
    `  db      ${opts.dbPath}\n` +
    `  mirrors ${opts.mirrorRoot}\n` +
    `  jobs    ${opts.concurrency}` +
    (opts.authToken ? '\n  auth    required' : '\n  auth    open (loopback only)'),
  );

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      console.log(`\n${signal} received, shutting down`);
      void daemon.close().then(() => process.exit(0));
    });
  }
}

start().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
