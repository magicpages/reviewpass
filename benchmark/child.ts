/**
 * One run in its own process, with its log beside its result and a failure
 * recorded when the process could not deliver one.
 */
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, writeFileSync } from 'node:fs';
import type { Run } from './types.js';

/**
 * Resolves once the child is gone, never rejects. A child that exits without
 * writing `out` - it crashed, or never started - leaves `failed(why)` there
 * instead: a gap would read as a run with no findings, and an unhandled spawn
 * error would take the whole benchmark down with it.
 */
export function spawnRun(command: string, args: string[], env: NodeJS.ProcessEnv, out: string,
  failed: (why: string) => Run): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    // The run's own log, beside it: a long review can be watched, a failed one read in full.
    const log = createWriteStream(out.replace(/\.json$/, '.log'));
    let err = '';
    let spawnError = '';
    child.stdout.on('data', (d) => process.stdout.write(`  ${d}`));
    child.stderr.on('data', (d) => { err += d; log.write(d); });
    // Emitted instead of a start when the command cannot run at all; `close` follows.
    child.on('error', (e) => { spawnError = e.message; });
    child.on('close', (code) => {
      log.end();
      if (code !== 0 && !existsSync(out)) {
        const why = spawnError ? `could not start ${command}: ${spawnError}`
          : `worker exited ${code}: ${err.trim().split('\n').slice(-3).join(' ').slice(0, 240)}`;
        writeFileSync(out, `${JSON.stringify(failed(why), null, 2)}\n`);
      }
      resolve();
    });
  });
}
