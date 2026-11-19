// Authored by Tomás Neto (TN 2026)
import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { EventLogger } from '../common/event-logger';
import { GatewayError } from '../common/errors';
import { bearerToken, clientIp } from '../common/http';
import { ipAllowed } from '../common/ip';
import { ApiKey } from '../generated/prisma/client';
import { AuthLimiterService } from './auth-limiter.service';
import { KeysService } from './keys.service';

export type ApiKeyRequest = Request & { apiKey: ApiKey };

/**
 * Bearer API key authentication. Failed attempts are counted per source IP and
 * locked out after AUTH_FAIL_MAX within AUTH_FAIL_WINDOW_SECONDS.
 * Disabled keys pass authentication; the send pipeline rejects them with KEY_DISABLED (audited).
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private readonly keys: KeysService,
    private readonly limiter: AuthLimiterService,
    private readonly events: EventLogger,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<ApiKeyRequest>();
    const ip = clientIp(req);
    const blocked = await this.limiter.isBlocked('api', ip);
    if (blocked) {
      this.events.emit('auth_rate_limited', { ip, outcome: 'rejected', reason: 'AUTH_RATE_LIMITED' });
      throw new GatewayError('AUTH_RATE_LIMITED', `Too many failed authentication attempts from this address. Retry in ${blocked}s.`, {
        retryAfterSeconds: blocked,
      });
    }
    const token = bearerToken(req);
    const key = token ? await this.keys.authenticate(token) : null;
    if (!key) {
      await this.limiter.recordFailure('api', ip);
      this.events.emit('auth_failed', { ip, outcome: 'rejected', reason: token ? 'INVALID_API_KEY' : 'MISSING_API_KEY', path: req.path });
      throw new GatewayError(
        token ? 'INVALID_API_KEY' : 'UNAUTHORIZED',
        token
          ? 'The API key is invalid or has been rotated/deleted. Send a valid key as "Authorization: Bearer mk_...".'
          : 'Missing API key. Send "Authorization: Bearer mk_..." with every request.',
      );
    }
    if (key.expiresAt && key.expiresAt.getTime() <= Date.now()) {
      this.events.emit('key_expired', { keyName: key.name, keyId: key.id, ip, outcome: 'rejected', reason: 'KEY_EXPIRED' });
      throw new GatewayError('KEY_EXPIRED', `API key "${key.name}" expired at ${key.expiresAt.toISOString()}. Ask an administrator for a new key; do not retry.`);
    }
    if (!ipAllowed(ip, key.allowedIps)) {
      this.events.emit('ip_not_allowed', { keyName: key.name, keyId: key.id, ip, outcome: 'rejected', reason: 'IP_NOT_ALLOWED' });
      throw new GatewayError('IP_NOT_ALLOWED', `API key "${key.name}" cannot be used from ${ip}. Its allowed sources are restricted by an administrator.`, { ip });
    }
    if (key.viaPrevious) {
      this.events.emit('previous_key_used', { keyName: key.name, keyId: key.id, ip, outcome: 'info', validUntil: key.prevKeyExpiresAt?.toISOString() });
    }
    req.apiKey = key;
    return true;
  }
}
