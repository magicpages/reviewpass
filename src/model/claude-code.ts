/**
 * Model calls through the official Claude Code CLI, on a Claude subscription.
 *
 * Each call is one `claude -p` process: no tools, no MCP servers, no settings or
 * CLAUDE.md from anywhere, no saved session, one turn, in an empty directory of
 * its own. The prompt goes in on stdin, the schema through `--json-schema`, and
 * the answer comes back as `structured_output`. The CLI owns authentication -
 * `claude setup-token`'s CLAUDE_CODE_OAUTH_TOKEN on a runner, or an existing
 * login - and this module never reads a credential.
 *
 * Two things would quietly move the bill from the subscription to API credit,
 * and both are ruled out here: `--bare`, which accepts only an API key, is never
 * passed; and ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN, which win over the
 * subscription login when present, are removed from the child's environment.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatMessage } from './client.js';

export interface ClaudeCodeRequest {
  model: string;
  system: string;
  prompt: string;
  schema?: object;
  /** `--effort`: low, medium, high, xhigh or max. Anything else is not sent. */
  effort?: string;
  timeoutMs: number;
  /** The CLI to run; `claude` on PATH by default. */
  command?: string;
}

export interface ClaudeCodeResult {
  value: string;
  stopReason?: string;
  promptTokens: number;
  completionTokens: number;
}

/** The subscription's 5-hour or weekly limit, or the account's usage cap: not worth a retry. */
export class ClaudeLimitError extends Error {}

/** The CLI is not signed in, or its token was rejected: not worth a retry either. */
export class ClaudeAuthError extends Error {}

const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const AUTH = /failed to authenticate|invalid bearer token|not logged in|please run \/login|invalid api key|oauth token (has )?expired|authentication_error/i;
const LIMIT = /hit your (session|weekly|usage) limit|usage limit reached|rate limit reached|out of extra usage|limit (will )?resets?/i;

/** The flags for one isolated, single-turn, tool-free call. Exported for tests. */
export function claudeArgs(req: Pick<ClaudeCodeRequest, 'model' | 'schema' | 'effort'>, systemFile: string): string[] {
  return [
    '-p',
    '--model', req.model,
    '--output-format', 'json',
    '--system-prompt-file', systemFile,
    '--tools', '',
    '--strict-mcp-config',
    '--setting-sources', '',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--max-turns', '1',
    ...(req.schema ? ['--json-schema', JSON.stringify(req.schema)] : []),
    ...(req.effort && EFFORTS.has(req.effort) ? ['--effort', req.effort] : []),
  ];
}

/** The environment the CLI runs in: everything but a key that would bill the API instead. */
export function claudeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env };
  delete out.ANTHROPIC_API_KEY;
  delete out.ANTHROPIC_AUTH_TOKEN;
  return out;
}

/** System messages become the system prompt; the rest, in order, the prompt. */
export function splitMessages(messages: ChatMessage[]): { system: string; prompt: string } {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const rest = messages.filter((m) => m.role !== 'system');
  const prompt = rest.length === 1
    ? rest[0]!.content
    : rest.map((m) => `## ${m.role}\n\n${m.content}`).join('\n\n');
  return { system, prompt };
}

interface CliReply {
  is_error?: boolean;
  subtype?: string;
  result?: unknown;
  structured_output?: unknown;
  stop_reason?: string | null;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
}

/** Read the CLI's JSON reply, or say why it is not one. Exported for tests. */
export function readReply(stdout: string, stderr: string, code: number | null): ClaudeCodeResult {
  let reply: CliReply | undefined;
  try { reply = JSON.parse(stdout.trim()) as CliReply; } catch { /* reported below */ }
  if (!reply || reply.is_error || reply.subtype !== 'success' || (code !== 0 && code !== null)) {
    // Only a failure is read for a limit: a review's own text can mention one.
    const said = `${typeof reply?.result === 'string' ? reply.result : ''} ${stderr} ${reply ? '' : stdout}`.trim();
    if (LIMIT.test(said)) throw new ClaudeLimitError(`Claude subscription limit: ${said.slice(0, 300)}`);
    if (AUTH.test(said)) throw new ClaudeAuthError(`Claude Code is not signed in: ${said.slice(0, 300)}`);
    throw new Error(reply
      ? `claude failed (${reply.subtype ?? 'error'}, exit ${code}): ${said.slice(0, 300)}`
      : `claude exited ${code} without a JSON reply: ${said.slice(0, 300)}`);
  }
  const value = reply.structured_output !== undefined
    ? JSON.stringify(reply.structured_output)
    : typeof reply.result === 'string' ? reply.result : '';
  const u = reply.usage ?? {};
  return {
    value,
    stopReason: reply.stop_reason ?? undefined,
    promptTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
    completionTokens: u.output_tokens ?? 0,
  };
}

/** One call. A limit fails at once; anything else is the caller's to retry. */
export async function claudeCodeCall(req: ClaudeCodeRequest): Promise<ClaudeCodeResult> {
  // A directory of its own: no CLAUDE.md to discover, nothing of the checkout's
  // to read or write, and the system prompt kept off the command line.
  const dir = mkdtempSync(join(tmpdir(), 'reviewpass-claude-'));
  try {
    const systemFile = join(dir, 'system.md');
    writeFileSync(systemFile, req.system || 'You are a careful code reviewer.');
    const child = spawn(req.command ?? 'claude', claudeArgs(req, systemFile), {
      cwd: dir, env: claudeEnv(process.env), stdio: ['pipe', 'pipe', 'pipe'], detached: true,
    });
    let stdout = '';
    let stderr = '';
    // Decoded as a stream: a character split across two chunks stays whole.
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => { stdout += d; });
    child.stderr.on('data', (d: string) => { stderr += d; });
    const timer = setTimeout(() => {
      // The CLI starts children of its own; take the whole group down.
      try { process.kill(-child.pid!, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    }, req.timeoutMs);
    const code = await new Promise<number | null>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
      // A CLI that exits before reading the whole prompt - a limit, a missing
      // login, the timeout - fails the write with EPIPE. Unhandled, that error
      // would end the whole review; the exit code and output say what happened.
      child.stdin.on('error', () => {});
      child.stdin.end(req.prompt);
    }).finally(() => clearTimeout(timer));
    if (code === null) throw new Error(`claude did not answer within ${Math.round(req.timeoutMs / 1000)}s`);
    return readReply(stdout, stderr, code);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
