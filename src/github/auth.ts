import { createSign } from 'node:crypto';

/**
 * Who the reviewer speaks as.
 *
 * The default token an Action is handed posts as `github-actions[bot]`, and
 * GitHub deliberately excludes that account from branch protection: it may
 * submit an approval, but the approval never counts toward a required review.
 * A reviewer that can request changes without those changes gating anything is
 * only pretending to be a gate, so anyone who wants the verdict to mean
 * something needs an identity of their own.
 *
 * That identity has to be a GitHub App the *adopter* owns. A single shared App
 * would mean somebody holding its private key and minting tokens for everyone
 * else - which is the hosted-service architecture this tool exists to avoid.
 * The cost of not doing that is real and worth stating plainly: there is no one
 * recognisable bot across every repository using this. Each installation has
 * its own. The comment markers keep the *tool* identifiable even when the
 * account is not.
 *
 * Tokens are minted here rather than by a separate action so the CLI and the
 * daemon get the same path, and so adopters need one fewer thing in their
 * workflow file. It needs no dependency: Node signs RS256 directly.
 */

export interface Identity {
  token: string;
  /**
   * The login this token posts as, when known - `reviewpass[bot]` for an App.
   *
   * Needed for loop prevention. Events caused by `GITHUB_TOKEN` never start a
   * workflow run, so the default path cannot trigger itself no matter how it is
   * wired. An App has no such protection: once the reviewer answers a reply, its
   * own answer is a `pull_request_review_comment` that starts the workflow that
   * answers replies. Knowing our own login is what stops that.
   */
  login?: string;
  /** True when this came from an App, so callers can enable App-only behaviour. */
  isApp: boolean;
}

/**
 * The REST root, so this works against GitHub Enterprise Server.
 *
 * Actions sets `GITHUB_API_URL` on every runner, including Enterprise ones, and
 * nothing here read it - so an audience that self-hosts deliberately could not
 * run the tool against their own GitHub at all.
 */
export function apiBaseUrl(): string {
  return (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');
}

/** The web root, for URLs a person opens rather than the API. Enterprise-aware. */
export function serverUrl(): string {
  return (process.env.GITHUB_SERVER_URL || 'https://github.com').replace(/\/+$/, '');
}

/** A short-lived JWT proving we hold the App's key. GitHub caps `exp` at 10 minutes. */
function appJwt(appId: string, privateKey: string): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  // `iat` is backdated because GitHub rejects a token whose clock is ahead of
  // theirs, and runner clocks drift.
  const data = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({ iat: now - 60, exp: now + 540, iss: appId })}`;
  const sig = createSign('RSA-SHA256').update(data).sign(normalizeKey(privateKey)).toString('base64url');
  return `${data}.${sig}`;
}

/**
 * PEM as GitHub issues it, whatever the secret store did to the newlines.
 *
 * A private key pasted into a secret often arrives with literal backslash-n
 * instead of real line breaks, and the resulting parse error says only
 * "unsupported", which is not a hint anybody can act on.
 */
function normalizeKey(key: string): string {
  const k = key.includes('\\n') ? key.replace(/\\n/g, '\n') : key;
  if (!k.includes('-----BEGIN')) {
    throw new Error('private-key does not look like a PEM. Paste the whole .pem file, BEGIN and END lines included.');
  }
  return k.trim();
}

async function api<T>(url: string, auth: string, method: 'GET' | 'POST' = 'GET'): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${auth}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'reviewpass',
    },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`${method} ${url} -> ${res.status} ${res.statusText} ${detail.slice(0, 300)}`);
  }
  return res.json() as Promise<T>;
}

/**
 * An installation token for this repository, plus the login it posts as.
 *
 * Only the App id and its key are required. The installation is discovered
 * rather than configured, because an installation id is the sort of number
 * people paste into the wrong repository's secrets and then cannot debug.
 */
export async function appToken(
  appId: string,
  privateKey: string,
  owner: string,
  repo: string,
): Promise<Identity> {
  const base = apiBaseUrl();
  const jwt = appJwt(appId, privateKey);

  const app = await api<{ slug: string }>(`${base}/app`, jwt);
  let installation: { id: number };
  try {
    installation = await api<{ id: number }>(`${base}/repos/${owner}/${repo}/installation`, jwt);
  } catch (err) {
    throw new Error(
      `App \`${app.slug}\` is not installed on ${owner}/${repo}. ` +
      `Install it at ${serverUrl()}/apps/${app.slug}/installations/new and grant ` +
      `"Pull requests: write". (${String(err).slice(0, 120)})`,
    );
  }

  const token = await api<{ token: string }>(
    `${base}/app/installations/${installation.id}/access_tokens`, jwt, 'POST',
  );
  return { token: token.token, login: `${app.slug}[bot]`, isApp: true };
}

/**
 * The identity to review as, preferring an App when one is configured.
 *
 * Falling back rather than failing is deliberate: the zero-configuration path
 * has to stay first-class. Creating a GitHub App usually needs an organisation
 * administrator, while adding a workflow file does not, so a tool that requires
 * one excludes the people most likely to try it first.
 */
export async function resolveIdentity(
  opts: { appId?: string; privateKey?: string; token?: string; owner: string; repo: string },
  log: (m: string) => void = () => {},
): Promise<Identity> {
  const appId = opts.appId?.trim();
  const privateKey = opts.privateKey?.trim();

  if (appId && privateKey) {
    const id = await appToken(appId, privateKey, opts.owner, opts.repo);
    log(`Reviewing as ${id.login}`);
    return id;
  }
  // Half a configuration is a mistake, not a preference. Silently posting as
  // `github-actions[bot]` because one of the two secrets was misspelled is how
  // somebody discovers their approvals never counted, weeks later.
  if (appId || privateKey) {
    throw new Error('app-id and private-key must be set together, or neither.');
  }

  if (!opts.token) throw new Error('No credentials: set github-token, or app-id and private-key.');
  log('Reviewing as github-actions[bot] (approvals will not count toward branch protection)');
  return { token: opts.token, isApp: false };
}
