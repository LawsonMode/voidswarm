// OWNER: AUTH agent. Password-reset mail: SMTP via nodemailer when SMTP_HOST is set, else a dev
// console fallback that logs the link (the ONLY place a token may ever be logged).
import type { Transporter } from 'nodemailer';

export interface ResetMail {
  to: string;
  username: string;
  url: string;
}

export interface Mailer {
  /** true when real SMTP is configured. */
  readonly smtp: boolean;
  /** Resolves when the mail has been handed off; rejects on failure (caller logs, never surfaces). */
  sendReset(mail: ResetMail): Promise<void>;
}

export type Env = Record<string, string | undefined>;

export function createMailer(env: Env, log: (line: string) => void): Mailer {
  const host = env.SMTP_HOST?.trim();
  if (!host) return createDevMailer(log);
  return createSmtpMailer(env, host, log);
}

export function createDevMailer(log: (line: string) => void): Mailer {
  return {
    smtp: false,
    async sendReset({ username, url }) {
      // Dev mode only (no SMTP configured): print the link so a local tester can use it.
      log(`[auth] DEV reset link for ${username}: ${url}`);
    },
  };
}

function createSmtpMailer(env: Env, host: string, log: (line: string) => void): Mailer {
  const port = Number(env.SMTP_PORT) || 587;
  const secureEnv = env.SMTP_SECURE?.trim();
  // SMTP_SECURE=1 → implicit TLS (port 465). Unset + port 465 → implicit TLS too.
  const secure = secureEnv ? secureEnv === '1' || secureEnv.toLowerCase() === 'true' : port === 465;
  const user = env.SMTP_USER?.trim() || undefined;
  const pass = env.SMTP_PASS ?? undefined;
  const from = env.MAIL_FROM?.trim() || (user && user.includes('@') ? `Voidswarm <${user}>` : 'Voidswarm <no-reply@localhost>');

  let transport: Promise<Transporter> | null = null;
  const getTransport = (): Promise<Transporter> => {
    transport ??= import('nodemailer').then((m) => {
      const nodemailer = (m as unknown as { default?: typeof m }).default ?? m;
      return nodemailer.createTransport({
        host,
        port,
        secure,
        // Never send credentials over a plaintext connection: require STARTTLS when authenticating.
        requireTLS: !secure && !!user,
        auth: user ? { user, pass: pass ?? '' } : undefined,
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 20_000,
      });
    });
    return transport;
  };

  log(`[auth] SMTP mail enabled via ${host}:${port}${secure ? ' (TLS)' : ''}${user ? ` as ${user}` : ''}`);

  return {
    smtp: true,
    async sendReset({ to, username, url }) {
      const t = await getTransport();
      await t.sendMail({
        from,
        to,
        subject: 'Reset your Voidswarm password',
        text: resetText(username, url),
        html: resetHtml(username, url),
      });
    },
  };
}

function resetText(username: string, url: string): string {
  return [
    `Hi ${username},`,
    '',
    'Someone (hopefully you) asked to reset the password for your Voidswarm account.',
    'Choose a new password here:',
    '',
    url,
    '',
    'This link expires in 30 minutes and works once.',
    "If you didn't ask for this, just ignore this email — your password won't change.",
    '',
    '— Voidswarm',
  ].join('\n');
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function resetHtml(username: string, url: string): string {
  const u = esc(url);
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#0b0f1a;font-family:Segoe UI,Arial,sans-serif;color:#dfe7ff">
<div style="max-width:480px;margin:0 auto;background:#131a2b;border:1px solid #2a3a66;border-radius:8px;padding:24px">
<h2 style="margin:0 0 12px;color:#5ef2ff">Voidswarm password reset</h2>
<p>Hi ${esc(username)},</p>
<p>Someone (hopefully you) asked to reset the password for your Voidswarm account.</p>
<p style="text-align:center;margin:24px 0"><a href="${u}" style="display:inline-block;padding:10px 20px;background:#5ef2ff;color:#0b0f1a;text-decoration:none;border-radius:4px;font-weight:bold">Choose a new password</a></p>
<p style="font-size:13px;color:#9aa8cc">Or paste this link into your browser:<br><span style="word-break:break-all">${u}</span></p>
<p style="font-size:13px;color:#9aa8cc">This link expires in 30 minutes and works once. If you didn't ask for this, just ignore this email — your password won't change.</p>
</div></body></html>`;
}
