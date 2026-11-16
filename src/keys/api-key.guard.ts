import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { EventLogger } from '../common/event-logger';
import { GatewayError } from '../common/errors';
import { bearerToken, clientIp } from '../common/http';
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
    req.apiKey = key;
    return true;
  }
}
