import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { UserRole, UserStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { setRequestActorRole } from '../../common/request-context/request-context';

export interface JwtPayload {
  sub: number;
  phone: string;
  role: UserRole;
  // users.sessionVersion at issue time. Optional only because tokens minted
  // before Phase 15B lack it; those count as version 0.
  sv?: number;
}

export interface AuthenticatedUser {
  id: number;
  phone: string;
  role: UserRole;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private readonly prisma: PrismaService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: process.env.JWT_ACCESS_SECRET,
    });
  }

  async validate(payload: JwtPayload): Promise<AuthenticatedUser> {
    const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });

    if (!user || user.status !== UserStatus.ACTIVE || user.deletedAt) {
      throw new UnauthorizedException('User is not active');
    }

    // A password reset or suspension bumps sessionVersion, which kills every
    // access token issued before it on the very next request.
    if ((payload.sv ?? 0) !== user.sessionVersion) {
      throw new UnauthorizedException('Session has been revoked');
    }

    setRequestActorRole(user.role);
    return { id: user.id, phone: user.phone, role: user.role };
  }
}
