import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { OtpCode, OtpPurpose, UserRole, UserStatus } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { VerifyResetCodeDto } from './dto/verify-reset-code.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { JwtPayload } from './strategies/jwt.strategy';

const BCRYPT_ROUNDS = 12;
const RESET_CODE_TTL_MINUTES = 15;
// OtpCode.attempts already exists for exactly this — cap how many wrong
// codes a request can absorb before it's dead, so a 6-digit code (only
// 900,000 possibilities) can't be brute-forced online.
const MAX_RESET_ATTEMPTS = 5;

interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
  ) {}

  async register(dto: RegisterDto) {
    // Defense in depth: RegisterDto already whitelists role to
    // CUSTOMER | BUSINESS_OWNER via @IsIn, so this branch should be
    // unreachable — but the public endpoint must NEVER be able to mint an
    // ADMIN account, so we refuse to trust validation alone.
    if ((dto.role as UserRole) === UserRole.ADMIN) {
      throw new ForbiddenException('Cannot register as ADMIN');
    }

    const existingPhone = await this.prisma.user.findUnique({ where: { phone: dto.phone } });
    if (existingPhone) {
      throw new ConflictException('Phone number is already registered');
    }

    if (dto.email) {
      const existingEmail = await this.prisma.user.findUnique({ where: { email: dto.email } });
      if (existingEmail) {
        throw new ConflictException('Email is already registered');
      }
    }

    if (dto.districtId) {
      const district = await this.prisma.district.findUnique({ where: { id: dto.districtId } });
      if (!district) {
        throw new NotFoundException(`District ${dto.districtId} not found`);
      }
    }

    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);
    const marketingConsent = dto.marketingConsent ?? false;

    const user = await this.prisma.user.create({
      data: {
        phone: dto.phone,
        email: dto.email,
        passwordHash,
        fullName: dto.fullName,
        role: dto.role ?? UserRole.CUSTOMER,
        districtId: dto.districtId,
        marketingConsent,
        // Only set when consent is actually granted — the timestamp records
        // the moment consent was given, not the registration time.
        marketingConsentAt: marketingConsent ? new Date() : null,
      },
    });

    const tokens = await this.issueTokens(user.id, user.phone, user.role);
    return { user: this.sanitizeUser(user), ...tokens };
  }

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({ where: { phone: dto.phone } });
    if (!user || user.deletedAt) {
      throw new UnauthorizedException('Invalid phone or password');
    }

    if (user.status !== UserStatus.ACTIVE) {
      throw new ForbiddenException('Account is not active');
    }

    const passwordValid = await bcrypt.compare(dto.password, user.passwordHash);
    if (!passwordValid) {
      throw new UnauthorizedException('Invalid phone or password');
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    const tokens = await this.issueTokens(user.id, user.phone, user.role);
    return { user: this.sanitizeUser(user), ...tokens };
  }

  async refresh(dto: RefreshDto) {
    const tokenHash = this.hashToken(dto.refreshToken);

    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });

    if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    if (!stored.user || stored.user.deletedAt || stored.user.status !== UserStatus.ACTIVE) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    // Rotate: revoke the used token and issue a brand new pair.
    await this.prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() },
    });

    const tokens = await this.issueTokens(stored.user.id, stored.user.phone, stored.user.role);
    return { user: this.sanitizeUser(stored.user), ...tokens };
  }

  async logout(refreshToken: string) {
    const tokenHash = this.hashToken(refreshToken);
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return { success: true };
  }

  // ============================================================================
  // PASSWORD RESET
  //
  // Reuses the existing OtpCode model (purpose=PASSWORD_RESET) rather than a
  // new table — it already has codeHash, attempts, expiresAt, usedAt, which
  // is everything this flow needs, and it was sitting unused.
  // ============================================================================

  async forgotPassword(dto: ForgotPasswordDto) {
    const user = await this.prisma.user.findUnique({ where: { phone: dto.phone } });

    // Always return the same response regardless of whether the phone is
    // registered — an endpoint that answers differently for known vs.
    // unknown phones is a phone-number enumeration oracle.
    if (user && !user.deletedAt && user.status === UserStatus.ACTIVE) {
      const code = String(Math.floor(100000 + Math.random() * 900000));
      const codeHash = await bcrypt.hash(code, BCRYPT_ROUNDS);
      const expiresAt = new Date(Date.now() + RESET_CODE_TTL_MINUTES * 60 * 1000);

      await this.prisma.otpCode.create({
        data: { phone: dto.phone, codeHash, purpose: OtpPurpose.PASSWORD_RESET, expiresAt },
      });

      // TODO(production): send via Eskiz SMS instead of logging. DEV MODE only —
      // this line must not ship once the SMS provider is wired up.
      // eslint-disable-next-line no-console
      console.log(`[DEV] Reset code for ${dto.phone}: ${code}`);
    }

    return { message: 'Kod yuborildi' };
  }

  async verifyResetCode(dto: VerifyResetCodeDto) {
    const record = await this.findValidResetCode(dto.phone, dto.code);
    if (!record) {
      throw new BadRequestException({ valid: false, message: "Noto'g'ri kod", statusCode: 400 });
    }
    return { valid: true };
  }

  async resetPassword(dto: ResetPasswordDto) {
    const record = await this.findValidResetCode(dto.phone, dto.code);
    if (!record) {
      throw new BadRequestException({ valid: false, message: "Noto'g'ri kod", statusCode: 400 });
    }

    const passwordHash = await bcrypt.hash(dto.newPassword, BCRYPT_ROUNDS);

    await this.prisma.$transaction([
      this.prisma.user.update({ where: { phone: dto.phone }, data: { passwordHash } }),
      this.prisma.otpCode.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
    ]);

    return { message: "Parol o'zgartirildi" };
  }

  // Multiple live codes can exist for one phone (each resend creates a new
  // row) — check newest-first against every still-valid one, and count a
  // wrong guess against MAX_RESET_ATTEMPTS on whichever row it was tried
  // against, not globally per phone.
  private async findValidResetCode(phone: string, code: string): Promise<OtpCode | null> {
    const candidates = await this.prisma.otpCode.findMany({
      where: {
        phone,
        purpose: OtpPurpose.PASSWORD_RESET,
        usedAt: null,
        expiresAt: { gt: new Date() },
        attempts: { lt: MAX_RESET_ATTEMPTS },
      },
      orderBy: { createdAt: 'desc' },
    });

    for (const candidate of candidates) {
      const matches = await bcrypt.compare(code, candidate.codeHash);
      if (matches) {
        return candidate;
      }
      await this.prisma.otpCode.update({
        where: { id: candidate.id },
        data: { attempts: { increment: 1 } },
      });
    }

    return null;
  }

  private async issueTokens(userId: number, phone: string, role: UserRole): Promise<TokenPair> {
    const payload: JwtPayload = { sub: userId, phone, role };

    const accessToken = await this.jwtService.signAsync(payload, {
      secret: process.env.JWT_ACCESS_SECRET,
      expiresIn: process.env.JWT_ACCESS_EXPIRES_IN ?? '15m',
    });

    const refreshToken = crypto.randomBytes(48).toString('hex');
    const tokenHash = this.hashToken(refreshToken);
    const expiresAt = this.addDuration(new Date(), process.env.JWT_REFRESH_EXPIRES_IN ?? '30d');

    await this.prisma.refreshToken.create({
      data: {
        userId,
        tokenHash,
        expiresAt,
      },
    });

    return { accessToken, refreshToken };
  }

  private hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  private addDuration(base: Date, duration: string): Date {
    const match = /^(\d+)([smhd])$/.exec(duration);
    if (!match) {
      // Fallback: treat unparsable values as 30 days.
      return new Date(base.getTime() + 30 * 24 * 60 * 60 * 1000);
    }
    const value = Number(match[1]);
    const unit = match[2];
    const unitMs: Record<string, number> = {
      s: 1000,
      m: 60 * 1000,
      h: 60 * 60 * 1000,
      d: 24 * 60 * 60 * 1000,
    };
    return new Date(base.getTime() + value * unitMs[unit]);
  }

  private sanitizeUser<T extends { passwordHash: string }>(user: T) {
    const { passwordHash, ...rest } = user;
    return rest;
  }
}
