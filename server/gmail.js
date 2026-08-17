/**
 * Send email via Gmail SMTP directly from Node (no external script, no deps).
 *
 * Uses Gmail's standard SMTP with STARTTLS and an app password. Credentials
 * come ONLY from the environment — never hardcode them.
 *
 * Env:
 *   SMTP_USER   (default danoclawnor@gmail.com)
 *   SMTP_PASS   (required — Gmail app password)
 *   REPORT_TO   (default recipient)
 */

import { createConnection } from 'node:net';
import { connect as tlsConnect } from 'node:tls';

const HOST = 'smtp.gmail.com';
const PORT = 587;
const USER = process.env.SMTP_USER || 'danoclawnor@gmail.com';
const PASS = process.env.SMTP_PASS;

/** Minimal SMTP conversation over a socket. */
class Smtp {
  constructor(socket) {
    this.socket = socket;
    this.buffer = '';
    this.waiters = [];
    socket.on('data', (d) => {
      this.buffer += d.toString();
      this._drain();
    });
  }
  _drain() {
    while (this.buffer.includes('\n')) {
      const i = this.buffer.indexOf('\n');
      const line = this.buffer.slice(0, i).replace(/\r$/, '');
      this.buffer = this.buffer.slice(i + 1);
      const w = this.waiters.shift();
      if (w) w(line);
    }
  }
  _next() {
    return new Promise((r) => this.waiters.push(r));
  }
  async cmd(text) {
    this.socket.write(text + '\r\n');
    return this._next();
  }
  raw(text) {
    this.socket.write(text);
  }
}

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

/**
 * Send an HTML email via Gmail SMTP.
 * @param {object} opts { to, subject, html, fromName }
 */
export async function sendEmail(opts = {}) {
  if (!PASS) throw new Error('SMTP_PASS env var is required (Gmail app password)');

  const to = opts.to || process.env.REPORT_TO || 'legacyboy@gmail.com';
  const from = USER;
  const subject = opts.subject || 'Tabletop Exercise Report';
  const html = opts.html || '';
  const fromName = opts.fromName || 'Tabletop D20';

  const socket = createConnection({ host: HOST, port: PORT });
  const smtp = new Smtp(socket);
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });

  await smtp._next(); // 220 greeting
  await smtp.cmd(`EHLO ${HOST}`);
  await smtp.cmd('STARTTLS');

  const tls = tlsConnect({ socket, servername: HOST });
  const t = new Smtp(tls);
  await new Promise((resolve, reject) => {
    tls.once('secureConnect', resolve);
    tls.once('error', reject);
  });

  await t.cmd(`EHLO ${HOST}`);
  await t.cmd('AUTH LOGIN');
  await t.cmd(b64(USER));
  await t.cmd(b64(PASS));
  await t.cmd(`MAIL FROM:<${from}>`);
  await t.cmd(`RCPT TO:<${to}>`);
  await t.cmd('DATA');

  const headers = [
    `From: ${fromName} <${from}>`,
    `To: <${to}>`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=utf-8',
    '',
  ].join('\r\n');

  t.raw(headers + '\r\n' + html + '\r\n.\r\n');
  await t._next(); // 250 queued
  await t.cmd('QUIT');
  tls.end();

  return { to, subject };
}
