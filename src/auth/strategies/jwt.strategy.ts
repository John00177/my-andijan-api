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
  // users.sessionVersion at issue time. Optional only because tokens minted
  // before Phase 15B lack it; those count as version 0.
  sv?: number;
  // The AuthSession this token was issued for (Phase 15E.4d.1). Every token
  // AuthService issues carries it. Optional only while access tokens issued
  // before 15E.4d.1 can still be unexpired; 15E.4d.2 makes it mandatory.
  sid?: number;
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
    if ((payload.sv ?? 0) !== user.sessionVersion) {
      throw new UnauthorizedException();
    }

    // Session binding (Phase 15E.4d.1): a token that names its session is
    // only good while that session is — so logout, refresh-token reuse
    // revocation and the absolute expiry end it at once. A token without
    // `sid` predates 15E.4d.1 and keeps the checks above until it expires.
    if (payload.sid !== undefined) {
      await this.assertSessionActive(payload.sid, user.id);
    }

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
