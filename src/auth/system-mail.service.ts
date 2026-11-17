import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, AppConfig, systemMailProvider } from '../config/config';
import { EventLogger } from '../common/event-logger';
import { QueueService } from '../queue/queue.service';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * System emails (admin invites). The API has no provider credentials, so it queues the email and
 * the worker delivers it with the live provider (SMTP or Resend) from SYSTEM_MAIL_FROM.
 */
@Injectable()
export class SystemMailService {
  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly queues: QueueService,
    private readonly events: EventLogger,
  ) {}

  get available(): boolean {
    return systemMailProvider(this.cfg) !== null;
  }

  /** Absolute link: PUBLIC_URL when set, else the (already same-origin-checked) browser origin. */
  absoluteUrl(path: string, origin?: string): string {
    return new URL(path, this.cfg.PUBLIC_URL ?? origin ?? 'http://localhost').toString();
  }

  /** Returns true when the invite email was queued. */
  async sendInvite(to: string, link: string, opts: { expiresInHours: number; invitedBy: string; reset?: boolean }): Promise<boolean> {
    if (!this.available) return false;
    const action = opts.reset ? 'reset your access to' : 'join';
    const subject = opts.reset ? 'Reset your mail-gateway access' : "You've been invited to mail-gateway";
    const text = [
      `Hello,`,
      ``,
      `${opts.invitedBy} invited you to ${action} the mail-gateway admin console.`,
      `Set your password here (valid for ${opts.expiresInHours} hours, single use):`,
      ``,
      link,
      ``,
      `If you did not expect this email, you can ignore it.`,
    ].join('\n');
    const html = `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#18181b;line-height:1.5">
<p>Hello,</p>
<p><b>${esc(opts.invitedBy)}</b> invited you to ${action} the <b>mail-gateway</b> admin console.</p>
<p><a href="${esc(link)}" style="display:inline-block;background:#4f46e5;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Set your password</a></p>
<p style="color:#71717a;font-size:13px">The link is valid for ${opts.expiresInHours} hours and can be used once.<br>If the button does not work, copy this address:<br><span style="word-break:break-all">${esc(link)}</span></p>
<p style="color:#71717a;font-size:13px">If you did not expect this email, you can ignore it.</p>
</body></html>`;
    await this.queues.systemMail.add(
      'invite',
      { kind: 'invite', to, subject, text, html },
      { attempts: 5, backoff: { type: 'exponential', delay: 10_000 }, removeOnComplete: true, removeOnFail: { age: 86_400 } },
    );
    // never log the link (it is a credential)
    this.events.emit('system_mail_queued', { outcome: 'info', kind: 'invite', to });
    return true;
  }
}
