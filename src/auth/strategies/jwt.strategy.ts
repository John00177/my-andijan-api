import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { SessionRevokedReason, UserRole, UserStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { getRequestContext, setRequestActorRole } from '../../common/request-context/request-context';

export interface JwtPayload {
  sub: number;
  phone: string;
  role: UserRole;
  // users.sessionVersion at issue time. Mandatory since Phase 15E.4e.1: every
  // token AuthService has signed since Phase 15B carries it, and every token
  // that can pass the mandatory `sid` check (15E.4d.2) was signed after that.
  // Still checked at runtime — a decoded payload is untrusted input.
  sv: number;
  // The AuthSession this token was issued for (Phase 15E.4d.1), mandatory
  // since Phase 15E.4d.2: every token AuthService issues carries it, and a
  // token without a valid one is refused. Required here because that is the
  // invariant for every token we sign. A decoded payload is still untrusted
  // input, so JwtStrategy re-checks its presence and shape at runtime.
  sid: number;
}

export interface AuthenticatedUser {
  id: number;
  phone: string;
  role: UserRole;
}

type SessionState = {
  userId: number;
  revokedAt: Date | null;
  revokedReason: SessionRevokedReason | null;
  absoluteExpiresAt: Date;
};

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  private readonly logger = new Logger(JwtStrategy.name);

  constructor(private readonly prisma: PrismaService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: process.env.JWT_ACCESS_SECRET,
    });
  }

  // Runs only after passport has verified the signature and `exp`. Every
  // refusal is the same bare 401 — passport's own "Unauthorized" — so the
  // response never says whether the account, the session or the token was
  // the problem.
  async validate(payload: JwtPayload): Promise<AuthenticatedUser> {
    const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });

    if (!user || user.status !== UserStatus.ACTIVE || user.deletedAt) {
      throw new UnauthorizedException();
    }

    // A password reset or suspension bumps sessionVersion, which kills every
    // access token issued before it on the very next request (user-wide).
    // Strict equality with the stored integer also refuses a token whose `sv`
    // is missing or not a number (no more "absent counts as 0" — 15E.4e.1).
    if (payload.sv !== user.sessionVersion) {
      throw new UnauthorizedException();
    }

    // Session binding — mandatory since Phase 15E.4d.2. A token is only good
    // while the session it names is, so logout, refresh-token reuse
    // revocation and the absolute expiry end it at once. A token with no
    // valid `sid` (absent, null, malformed) is refused with the same bare
    // 401; the 15E.4d.1 compatibility path for pre-`sid` tokens is gone —
    // the longest-lived of them expired one access-token lifetime after
    // 15E.4d.1 went live.
    await this.assertSessionActive(payload.sid, user.id);

    setRequestActorRole(user.role);
    return { id: user.id, phone: user.phone, role: user.role };
  }

  /**
   * One primary-key read. The session must exist, belong to this user, be
   * unrevoked and be inside its absolute lifetime. A failed lookup refuses
   * (fail closed). Log lines carry ids only — never the token.
   */
  private async assertSessionActive(sid: unknown, userId: number): Promise<void> {
    if (typeof sid !== 'number' || !Number.isSafeInteger(sid) || sid <= 0) {
      throw new UnauthorizedException();
    }

    let session: SessionState | null;
    try {
      session = await this.prisma.authSession.findUnique({
        where: { id: sid },
        select: { userId: true, revokedAt: true, revokedReason: true, absoluteExpiresAt: true },
      });
    } catch {
      this.logger.error(`Access-token session lookup failed; request refused (session=${sid} request=${requestId()})`);
      throw new UnauthorizedException();
    }

    if (!session) {
      // Impossible with a validly signed token unless rows were removed.
      this.logger.warn(`Access token names an unknown session (session=${sid} user=${userId} request=${requestId()})`);
      throw new UnauthorizedException();
    }
    if (session.userId !== userId) {
      // Impossible without the signing secret or a bug: suspicious by definition.
      this.logger.warn(
        `Access token names another user's session (session=${sid} user=${userId} request=${requestId()})`,
      );
      throw new UnauthorizedException();
    }
    if (session.revokedAt) {
      if (session.revokedReason === SessionRevokedReason.REUSE_DETECTED) {
        // The stolen chain (or the victim's tab) is still in use after 15E.4c revoked it.
        this.logger.warn(
          `Access token used for a session revoked for refresh-token reuse (session=${sid} user=${userId} request=${requestId()})`,
        );
      }
      throw new UnauthorizedException();
    }
    if (session.absoluteExpiresAt <= new Date()) {
      throw new UnauthorizedException();
    }
  }
}

/** The server-generated request id, for log lines. */
function requestId(): string {
  return getRequestContext()?.requestId ?? '-';
}
