import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { apiBaseUrl, serverUrl } from './github/auth.js';

/**
 * Create the GitHub App, without a server of ours in the loop.
 *
 * The honest objection to "bring your own App" is friction: register an app,
 * pick permissions, generate a key, download it, paste two secrets. Enough
 * steps to lose people, and every skipped one fails later in a way that reads
 * as the tool being broken.
 *
 * GitHub's App Manifest flow collapses that into one confirmation, but it hands
 * the result back to a `redirect_url` - which sounds like it needs a service to
 * receive it. It does not. The redirect happens in the adopter's own browser,
 * so the receiver can be a socket on their own machine that lives for the
 * length of the command. Nothing of ours is involved at any point, which is the
 * property the whole design is for.
 *
 * What comes back from the exchange is the App id and its private key, so the
 * command can print exactly the two secrets the workflow needs.
 */

const PERMISSIONS = {
  // Everything the reviewer does is a pull request comment or a review.
  pull_requests: 'write',
  // Read the files being reviewed and the repository's own rule files.
  contents: 'read',
  metadata: 'read',
} as const;

/** Where the App points people who click its name. Also stands in for the hook. */
const HOMEPAGE = 'https://github.com/magicpages/reviewpass';

/**
 * A webhook that is named but switched off.
 *
 * This App exists to be an identity and to mint tokens. The reviewer is started
 * by workflow triggers in the adopter's own `.yml`, never by a webhook to a
 * server of ours - there is no server of ours - so there is nothing to receive
 * a delivery and no events are subscribed.
 *
 * GitHub still requires a URL. `hook_attributes.url` is mandatory whenever the
 * object is present at all, and omitting the field is not the way out either:
 * declaring any `default_events` makes GitHub demand a hook URL as well. Two
 * rejections taught this one - "Hook url cannot be blank" for the events, then
 * `"url" wasn't supplied` for a `hook_attributes` carrying only `active`, which
 * reads as though the homepage were missing and is not.
 *
 * So: a real URL that will never be called, and `active: false` so GitHub does
 * not try.
 */
const HOOK = { url: HOMEPAGE, active: false } as const;

/**
 * Keep the key out of the commit that follows.
 *
 * The command writes a private key into whatever directory it was run from,
 * which for most people is the repository they are setting the reviewer up on.
 * Mode 600 stops another user reading it and does nothing at all about `git add
 * .`, which is the way this credential would actually escape. Documenting the
 * risk is not a control; the file is ignored before the terminal says it exists.
 */
function ignoreKey(keyPath: string): boolean {
  try {
    if (!existsSync('.git')) return false;
    const line = keyPath.startsWith('/') ? '*.private-key.pem' : keyPath;
    const current = existsSync('.gitignore') ? readFileSync('.gitignore', 'utf8') : '';
    if (current.split('\n').some((l) => l.trim() === line || l.trim() === '*.pem')) return false;
    appendFileSync('.gitignore',
      `${current && !current.endsWith('\n') ? '\n' : ''}\n# GitHub App private key written by \`reviewpass init-app\`\n${line}\n`);
    return true;
  } catch {
    return false;
  }
}

/** Full attribute escaping, so no character in the manifest can end the attribute. */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'start'
    : 'xdg-open';
  try {
    spawn(cmd, [url], { stdio: 'ignore', detached: true }).unref();
  } catch {
    // Headless, or no desktop. The URL is printed either way.
  }
}

export interface InitAppOptions {
  /** Organisation to create the App in. Omitted means the personal account. */
  org?: string;
  /** App name. Must be unique across GitHub; the slug becomes the bot's login. */
  name?: string;
  /** Where to write the private key. */
  keyPath?: string;
  port?: number;
  /** Open a browser. Off in tests: this drives the machine's real browser. */
  openBrowser?: boolean;
}

export async function initApp(opts: InitAppOptions = {}): Promise<number> {
  const name = opts.name ?? 'reviewpass';
  const keyPath = opts.keyPath ?? `${name}.private-key.pem`;
  const state = randomBytes(16).toString('hex');

  return new Promise<number>((resolve) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');

      if (url.pathname === '/') {
        // The manifest flow is a form POST, so serve a page that submits one.
        const target = opts.org
          ? `${serverUrl()}/organizations/${opts.org}/settings/apps/new?state=${state}`
          : `${serverUrl()}/settings/apps/new?state=${state}`;
        const manifest = {
          name,
          url: HOMEPAGE,
          description: 'Reviews pull requests, verifying each finding against the code before posting it.',
          public: false,
          redirect_url: `http://localhost:${(server.address() as { port: number }).port}/callback`,
          default_permissions: PERMISSIONS,
          hook_attributes: HOOK,
        };
        // Printed as well as posted. GitHub validates the manifest on its side
        // and reports the failure on its own error page, which the terminal
        // never sees - so a rejection was unactionable from here. Whatever it
        // objects to, the exact bytes it objected to are now on screen.
        const json = JSON.stringify(manifest);
        console.log('  Manifest being sent:\n');
        console.log(`${JSON.stringify(manifest, null, 2).split('\n').map((l) => `    ${l}`).join('\n')}\n`);

        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(
          `<!doctype html><html><head><meta charset="utf-8"><title>Creating ${esc(name)}</title></head>` +
          `<body style="font:16px system-ui;margin:4rem auto;max-width:34rem">` +
          `<p>Sending you to GitHub to create the <b>${esc(name)}</b> app…</p>` +
          `<form id="f" method="post" enctype="application/x-www-form-urlencoded" action="${esc(target)}">` +
          `<input type="hidden" name="manifest" value="${esc(json)}">` +
          `<button type="submit">Continue</button></form>` +
          // Submitting once. An auto-submit plus a visible button is two ways to
          // send the same form, and a second POST reuses a spent state.
          `<script>document.getElementById('f').submit()</script></body></html>`,
        );
        return;
      }

      if (url.pathname === '/callback') {
        const code = url.searchParams.get('code');
        // The state check matters even on localhost: any page the adopter has
        // open can reach this port while it is listening.
        if (url.searchParams.get('state') !== state || !code) {
          res.writeHead(400, { 'content-type': 'text/plain' });
          res.end('Bad state or missing code. Run the command again.');
          return;
        }
        try {
          const conv = await fetch(`${apiBaseUrl()}/app-manifests/${code}/conversions`, {
            method: 'POST',
            headers: { accept: 'application/vnd.github+json', 'user-agent': 'reviewpass' },
          });
          if (!conv.ok) throw new Error(`${conv.status} ${await conv.text()}`);
          const app = await conv.json() as { id: number; slug: string; pem: string; html_url: string };

          writeFileSync(keyPath, app.pem, { mode: 0o600 });
          const ignored = ignoreKey(keyPath);

          res.writeHead(200, { 'content-type': 'text/html' });
          res.end(
            `<!doctype html><meta charset="utf-8"><title>${app.slug} created</title>` +
            `<body style="font:16px system-ui;margin:4rem auto;max-width:32rem">` +
            `<h1>${app.slug} created</h1><p>Return to your terminal. You can close this tab.</p>`,
          );

          console.log(`\n  Created ${app.slug} (app id ${app.id})`);
          console.log(`  Private key written to ${keyPath} (mode 600) — treat it as a credential.`);
          console.log(ignored
            ? '  Added it to .gitignore.\n'
            : '  NOT in a git repository, or .gitignore already covers it.\n');
          console.log('  Two more steps:\n');
          console.log(`  1. Install it on the repositories you want reviewed:`);
          console.log(`       ${app.html_url}/installations/new\n`);
          console.log(`  2. Add these repository secrets:`);
          console.log(`       REVIEWPASS_APP_ID      ${app.id}`);
          console.log(`       REVIEWPASS_PRIVATE_KEY  (the contents of ${keyPath})\n`);
          console.log('  Then pass them to the action:\n');
          console.log('       with:');
          console.log('         app-id: ${{ secrets.REVIEWPASS_APP_ID }}');
          console.log('         private-key: ${{ secrets.REVIEWPASS_PRIVATE_KEY }}\n');
          server.close();
          resolve(0);
        } catch (err) {
          res.writeHead(500, { 'content-type': 'text/plain' });
          res.end(String(err));
          console.error(`\n  Could not complete the exchange: ${String(err).slice(0, 300)}`);
          console.error('  The code expires an hour after the app is created; run the command again.\n');
          server.close();
          resolve(1);
        }
        return;
      }

      res.writeHead(404).end();
    });

    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      const where = opts.org ? `the ${opts.org} organisation` : 'your personal account';
      console.log(`\n  Creating the GitHub App "${name}" in ${where}.`);
      console.log('  Nothing is sent anywhere except GitHub — the callback is this machine.\n');
      console.log(`  Opening http://localhost:${port}/`);
      console.log('  (if no browser opens, paste that into one)\n');
      if (opts.openBrowser !== false) openBrowser(`http://localhost:${port}/`);
    });
  });
}
