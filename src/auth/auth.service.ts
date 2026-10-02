import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AuditAction, OtpCode, OtpPurpose, Prisma, UserRole, UserStatus } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { VerifyResetCodeDto } from './dto/verify-reset-code.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { RequestOtpDto } from './dto/request-otp.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { SmsService } from '../sms/sms.service';
import { UploadService } from '../upload/upload.service';
import { JwtPayload } from './strategies/jwt.strategy';
import { auditRequestFields } from '../common/request-context/request-context';
import { capabilitiesFor } from '../authz/capabilities';

const BCRYPT_ROUNDS = 12;
const RESET_CODE_TTL_MINUTES = 15;
const OTP_TTL_MINUTES = 5;
const OTP_RATE_WINDOW_MINUTES = 10;
const OTP_MAX_PER_WINDOW = 3;
const MAX_OTP_ATTEMPTS = 5;
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
    private readonly smsService: SmsService,
    private readonly uploadService: UploadService,
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

    const tokens = await this.issueTokens(user);
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

    const tokens = await this.issueTokens(user);
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

    const tokens = await this.issueTokens(stored.user);
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
  // PHONE OTP AUTH  (passwordless signup + login)
  //
  // Codes live in the existing OtpCode table under purpose=LOGIN, not in
  // Redis. The table already provides everything the flow needs — a TTL via
  // expiresAt, an attempts counter, single-use via usedAt — and it is what
  // password reset above already uses. Postgres also gets this durability for
  // free: a restart cannot strand a user who is mid-verification holding a
  // code that no longer exists anywhere. Codes are stored bcrypt-hashed, so a
  // database leak does not hand over live login codes.
  // ============================================================================

  async requestOtp(dto: RequestOtpDto) {
    await this.assertOtpRateLimit(dto.phone);

    const code = this.generateOtpCode();
    const codeHash = await bcrypt.hash(code, BCRYPT_ROUNDS);
    const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);

    // Any earlier live code is retired the moment a new one is issued, so a
    // resend cannot leave two working codes for the same phone.
    await this.prisma.$transaction([
      this.prisma.otpCode.updateMany({
        where: { phone: dto.phone, purpose: OtpPurpose.LOGIN, usedAt: null },
        data: { usedAt: new Date() },
      }),
      this.prisma.otpCode.create({
        data: { phone: dto.phone, codeHash, purpose: OtpPurpose.LOGIN, expiresAt },
      }),
    ]);

    // The trailing "@domain #code" line is what lets Android's WebOTP API
    // offer the code straight from the notification, and it must be the last
    // line of the message for the browser to accept it.
    const message = `My Andijan tasdiqlash kodi: ${code}. @myandijan.uz #${code}`;
    await this.smsService.send(dto.phone, message);

    return { success: true, message: 'Kod yuborildi' };
  }

  async verifyOtp(dto: VerifyOtpDto) {
    const record = await this.findValidOtp(dto.phone, dto.otp, OtpPurpose.LOGIN);
    if (!record) {
      throw new BadRequestException("Kod noto'g'ri yoki muddati tugagan");
    }

    let user = await this.prisma.user.findUnique({ where: { phone: dto.phone } });

    if (user && (user.deletedAt || user.status !== UserStatus.ACTIVE)) {
      throw new ForbiddenException('Account is not active');
    }

    if (!user) {
      // First sign-in for this number: create the account now, so the profile
      // step that follows is optional rather than a second gate.
      //
      // passwordHash is non-nullable and this user has no password. Rather
      // than widen the column (which would make every bcrypt.compare in
      // login() a null check), they get an unguessable random hash: the
      // account simply cannot be reached by password until the user sets one
      // through the reset flow. There is no value an attacker can submit that
      // hashes to it.
      const unusablePassword = crypto.randomBytes(48).toString('hex');
      user = await this.prisma.user.create({
        data: {
          phone: dto.phone,
          passwordHash: await bcrypt.hash(unusablePassword, BCRYPT_ROUNDS),
          // fullName is required; the profile step fills it in properly and
          // an empty string is preferable to inventing a placeholder name
          // that would then be rendered on the user's public reviews.
          fullName: '',
          role: UserRole.CUSTOMER,
          phoneVerified: true,
        },
      });
    }

    await this.prisma.$transaction([
      this.prisma.otpCode.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
      this.prisma.user.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date(), phoneVerified: true },
      }),
    ]);

    const tokens = await this.issueTokens(user);
    return { user: this.sanitizeUser({ ...user, phoneVerified: true }), ...tokens };
  }

  async updateProfile(userId: number, dto: UpdateProfileDto, photo?: Express.Multer.File) {
    const composedName = [dto.firstName, dto.lastName]
      .filter((part): part is string => !!part && part.trim().length > 0)
      .join(' ')
      .trim();
    const fullName = composedName || dto.fullName?.trim();

    const avatarUrl = photo ? (await this.uploadService.uploadImage(photo)).url : undefined;

    const user = await this.prisma.user.update({
      where: { id: userId },
      data: {
        ...(fullName ? { fullName } : {}),
        ...(avatarUrl ? { avatarUrl } : {}),
      },
    });

    return { success: true, user: this.sanitizeUser(user) };
  }

  /**
   * Caps how often one phone can trigger an SMS. Counted from the OtpCode
   * rows themselves rather than an in-memory bucket, so the limit survives a
   * restart and holds across every instance Railway runs — an in-process
   * counter would reset on deploy and be per-instance, which is exactly when
   * someone hammering the endpoint would get through.
   */
  private async assertOtpRateLimit(phone: string): Promise<void> {
    const since = new Date(Date.now() - OTP_RATE_WINDOW_MINUTES * 60 * 1000);
    const recent = await this.prisma.otpCode.count({
      where: { phone, purpose: OtpPurpose.LOGIN, createdAt: { gte: since } },
    });

    if (recent >= OTP_MAX_PER_WINDOW) {
      throw new HttpException(
        `Juda ko'p urinish. ${OTP_RATE_WINDOW_MINUTES} daqiqadan so'ng qayta urinib ko'ring.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private generateOtpCode(): string {
    // crypto.randomInt, not Math.random: this is a credential, and
    // Math.random is neither uniform nor unpredictable.
    return String(crypto.randomInt(100000, 1000000));
  }

  private async findValidOtp(phone: string, code: string, purpose: OtpPurpose): Promise<OtpCode | null> {
    const candidates = await this.prisma.otpCode.findMany({
      where: {
        phone,
        purpose,
        usedAt: null,
        expiresAt: { gt: new Date() },
        attempts: { lt: MAX_OTP_ATTEMPTS },
      },
      orderBy: { createdAt: 'desc' },
    });

    for (const candidate of candidates) {
      if (await bcrypt.compare(code, candidate.codeHash)) {
        return candidate;
      }
      await this.prisma.otpCode.update({
        where: { id: candidate.id },
        data: { attempts: { increment: 1 } },
      });
    }

    return null;
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
    const now = new Date();

    // One transaction: the new password, the end of every existing session
    // (refresh tokens revoked; sessionVersion bumped so outstanding access
    // tokens die on their next request) and the security audit row. Whoever
    // held the old credentials — including an attacker — is signed out; the
    // user signs in again with the new password (Phase 15B).
    await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.update({
        where: { phone: dto.phone },
        data: { passwordHash, sessionVersion: { increment: 1 } },
      });
      await tx.otpCode.update({ where: { id: record.id }, data: { usedAt: now } });
      const revoked = await tx.refreshToken.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: now },
      });
      await tx.auditLog.create({
        data: {
          ...auditRequestFields(),
          actorId: user.id,
          actorRole: user.role,
          action: AuditAction.UPDATE,
          entityType: 'UserCredentials',
          entityId: user.id,
          before: {} as Prisma.InputJsonValue,
          after: { passwordReset: true, sessionsRevoked: revoked.count } as Prisma.InputJsonValue,
          note: 'Password reset via SMS code',
        },
      });
    });

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

  private async issueTokens(user: {
    id: number;
    phone: string;
    role: UserRole;
    sessionVersion: number;
  }): Promise<TokenPair> {
    const userId = user.id;
    const payload: JwtPayload = { sub: user.id, phone: user.phone, role: user.role, sv: user.sessionVersion };

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

  // Every auth response carries the user's capabilities (D-75) so the
  // frontend can render immediately after sign-in. Display hint only.
  private sanitizeUser<T extends { passwordHash: string; role: UserRole }>(user: T) {
    const { passwordHash, ...rest } = user;
    return { ...rest, capabilities: capabilitiesFor(user.role) };
  }
}
