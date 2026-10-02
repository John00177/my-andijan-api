import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AuditAction, OtpCode, OtpPurpose, Prisma, SessionRevokedReason, User, UserRole, UserStatus } from '@prisma/client';
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
import {
  ABSOLUTE_SESSION_TTL_MS,
  legacySessionExpiry,
  refreshTokenExpiry,
  revokeAllUserSessions,
  sessionDeviceMetadata,
} from './refresh-sessions';

const BCRYPT_ROUNDS = 12;
const RESET_CODE_TTL_MINUTES = 15;
const OTP_TTL_MINUTES = 5;
const OTP_RATE_WINDOW_MINUTES = 10;
const OTP_MAX_PER_WINDOW = 3;
// Wrong-guess budget per phone + purpose (Phase 15E.2). It is counted across
// EVERY code row created for that phone and purpose inside the window —
// live, superseded, used or expired — so requesting a fresh code never buys
// more guesses. A 6-digit code has only 900,000 values; 5 guesses an hour
// keeps online brute force negligible.
const CODE_FAILURE_WINDOW_MINUTES = 60;
const MAX_CODE_FAILURES_PER_WINDOW = 5;
// Who may sign in with an SMS code alone (Phase 15E.2). An allowlist, so any
// role added later is refused by default: staff (SUPPORT, MODERATOR, ADMIN,
// SUPER_ADMIN) must use their password — an SMS code is not a sufficient
// factor for a privileged account.
const OTP_LOGIN_ROLES: ReadonlySet<UserRole> = new Set<UserRole>([UserRole.CUSTOMER, UserRole.BUSINESS_OWNER]);
const INVALID_OTP_MESSAGE = "Kod noto'g'ri yoki muddati tugagan";
const INVALID_RESET_CODE = { valid: false, message: "Noto'g'ri kod", statusCode: 400 };
const OTP_LOGIN_UNAVAILABLE_MESSAGE = "Bu hisobga SMS kod bilan kirib bo'lmaydi. Parol bilan kiring.";
const SMS_UNAVAILABLE_MESSAGE = "SMS xizmati hozircha ishlamayapti. Keyinroq urinib ko'ring yoki parol bilan kiring.";

// Every refresh failure — unknown, expired, rotated, revoked, lost race,
// revoked or expired session, inactive user — gets this one 401, so a caller
// cannot tell a detected replay from an ordinary expiry (Phase 15E.4b).
const INVALID_REFRESH_MESSAGE = 'Invalid or expired refresh token';

interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

type SessionUser = Pick<User, 'id' | 'phone' | 'role' | 'sessionVersion'>;

/** Thrown inside a refresh transaction to roll ALL of it back; becomes the generic 401. */
class RefreshRejected extends Error {}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  /** A bcrypt hash of a random value, compared against when there is no real code — equal work either way. */
  private dummyCodeHash: Promise<string> | null = null;

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

    const tokens = await this.startSession(user);
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

    const tokens = await this.startSession(user);
    return { user: this.sanitizeUser(user), ...tokens };
  }

  /**
   * Race-safe rotation (Phase 15E.4b). One transaction; see
   * refresh-sessions.ts for the locking model. Of any number of concurrent
   * requests presenting the same token, exactly one gets a successor; every
   * other one gets the generic 401 and changes nothing.
   *
   * A token that was already rotated is refused with that same 401 and
   * nothing else happens: revoking the session on reuse is Phase 15E.4c.
   */
  async refresh(dto: RefreshDto) {
    const tokenHash = this.hashToken(dto.refreshToken);
    let rotated: { user: User; refreshToken: string };
    try {
      rotated = await this.prisma.$transaction((tx) => this.rotateRefreshToken(tx, tokenHash));
    } catch (error) {
      // P2002 is the parent_id UNIQUE backstop refusing a second successor —
      // unreachable while the locking below is correct, and a plain 401 if not.
      if (error instanceof RefreshRejected || isUniqueViolation(error)) {
        throw new UnauthorizedException(INVALID_REFRESH_MESSAGE);
      }
      throw error;
    }
    const accessToken = await this.signAccessToken(rotated.user);
    return { user: this.sanitizeUser(rotated.user), accessToken, refreshToken: rotated.refreshToken };
  }

  private async rotateRefreshToken(tx: Prisma.TransactionClient, tokenHash: string) {
    const now = new Date();

    // 1. Locate the token. No lock yet: this read decides only which session
    //    to lock, never whether to rotate.
    const presented = await tx.refreshToken.findUnique({
      where: { tokenHash },
      select: { id: true, sessionId: true },
    });
    if (!presented) throw new RefreshRejected();
    const sessionId = presented.sessionId ?? (await this.attachLegacySession(tx, presented.id, now));

    // 2. Serialization point: lock the session row. A concurrent refresh,
    //    logout or revocation of this session waits here until we commit, and
    //    the condition is re-checked against whatever it committed. Revoked,
    //    or past its absolute lifetime → refused.
    const locked = await tx.authSession.updateMany({
      where: { id: sessionId, revokedAt: null, absoluteExpiresAt: { gt: now } },
      data: { lastUsedAt: now },
    });
    if (locked.count !== 1) throw new RefreshRejected();
    const session = await tx.authSession.findUniqueOrThrow({
      where: { id: sessionId },
      select: { userId: true, absoluteExpiresAt: true },
    });

    // 3. Compare-and-set on the presented token, under the session lock. Only
    //    the request that flips rotatedAt from NULL may create a successor;
    //    for every other one the count is 0. revokedAt is set as well, so a
    //    rotated token stays dead even to code that predates rotatedAt (the
    //    previous release during a rolling deploy, or after a rollback).
    const cas = await tx.refreshToken.updateMany({
      where: { id: presented.id, sessionId, rotatedAt: null, revokedAt: null, expiresAt: { gt: now } },
      data: { rotatedAt: now, revokedAt: now },
    });
    if (cas.count !== 1) throw new RefreshRejected();

    // 4. The account must still be usable. Rejecting here rolls the rotation back.
    const user = await tx.user.findUnique({ where: { id: session.userId } });
    if (!user || user.deletedAt || user.status !== UserStatus.ACTIVE) throw new RefreshRejected();

    // 5. The one successor: same session, linked to its predecessor
    //    (parent_id UNIQUE), never outliving the session.
    const refreshToken = this.newRefreshToken();
    await tx.refreshToken.create({
      data: {
        userId: user.id,
        sessionId,
        parentId: presented.id,
        tokenHash: this.hashToken(refreshToken),
        expiresAt: refreshTokenExpiry(now, this.refreshTtlMs(), session.absoluteExpiresAt),
      },
    });
    return { user, refreshToken };
  }

  /**
   * A token issued by the pre-15E.4b code (during the rolling deploy, or not
   * live at backfill time) has no session. It gets one now, created and linked
   * inside the refresh transaction; the link is a compare-and-set on
   * session_id IS NULL, so of two concurrent first uses only one attaches —
   * the other is refused, and its rollback discards the session it made.
   * Removed by the 15E.4e contract step.
   */
  private async attachLegacySession(tx: Prisma.TransactionClient, tokenId: number, now: Date): Promise<number> {
    const token = await tx.refreshToken.findUniqueOrThrow({
      where: { id: tokenId },
      select: { userId: true, createdAt: true, expiresAt: true },
    });
    const session = await tx.authSession.create({
      data: {
        userId: token.userId,
        createdAt: token.createdAt,
        absoluteExpiresAt: legacySessionExpiry(token.createdAt, token.expiresAt),
        lastUsedAt: now,
        ...sessionDeviceMetadata(),
      },
      select: { id: true },
    });
    const attached = await tx.refreshToken.updateMany({
      where: { id: tokenId, sessionId: null, rotatedAt: null, revokedAt: null, expiresAt: { gt: now } },
      data: { sessionId: session.id },
    });
    if (attached.count !== 1) throw new RefreshRejected();
    return session.id;
  }

  /**
   * Ends the whole session the presented refresh token belongs to (Phase
   * 15E.4b). Possession of the session's CURRENT refresh token is the proof —
   * no access token is needed, so sign-out works after the access token has
   * expired. A token that is unknown, expired, revoked or already rotated
   * ends nothing (an old token must not be enough to end someone's session;
   * what a replayed rotated token should trigger is decided in 15E.4c). The
   * response is the same in every case.
   */
  async logout(refreshToken: string) {
    const tokenHash = this.hashToken(refreshToken);
    const now = new Date();

    await this.prisma.$transaction(async (tx) => {
      const presented = await tx.refreshToken.findUnique({
        where: { tokenHash },
        select: {
          id: true,
          sessionId: true,
          rotatedAt: true,
          revokedAt: true,
          expiresAt: true,
          user: { select: { id: true, role: true } },
        },
      });
      if (!presented || presented.rotatedAt || presented.revokedAt || presented.expiresAt <= now) return;

      if (presented.sessionId === null) {
        // Legacy token, no session yet: it is the whole session.
        await tx.refreshToken.updateMany({ where: { id: presented.id, revokedAt: null }, data: { revokedAt: now } });
        return;
      }

      // Session row first (it waits for a refresh in flight), then its tokens —
      // in a fresh snapshot that includes a successor that refresh committed.
      const session = await tx.authSession.updateMany({
        where: { id: presented.sessionId, revokedAt: null },
        data: { revokedAt: now, revokedReason: SessionRevokedReason.LOGOUT },
      });
      const tokens = await tx.refreshToken.updateMany({
        where: { sessionId: presented.sessionId, revokedAt: null },
        data: { revokedAt: now },
      });
      if (session.count === 1) {
        await tx.auditLog.create({
          data: {
            ...auditRequestFields(),
            actorId: presented.user.id,
            actorRole: presented.user.role,
            action: AuditAction.UPDATE,
            entityType: 'AuthSession',
            entityId: presented.sessionId,
            before: { revoked: false } as Prisma.InputJsonValue,
            after: {
              revoked: true,
              reason: SessionRevokedReason.LOGOUT,
              tokensRevoked: tokens.count,
            } as Prisma.InputJsonValue,
            note: 'Signed out',
          },
        });
      }
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
  //
  // Phase 15E.2: a code is never logged, returned or put in an exception —
  // it exists only in the SMS. With no SMS provider configured the request
  // fails (503) instead of pretending a code was sent.
  // ============================================================================

  async requestOtp(dto: RequestOtpDto) {
    this.assertSmsAvailable();
    await this.assertOtpRateLimit(dto.phone);

    const code = this.generateCode();
    const codeHash = await bcrypt.hash(code, BCRYPT_ROUNDS);
    const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);
    const issued = await this.issueCode(dto.phone, OtpPurpose.LOGIN, codeHash, expiresAt);

    // The trailing "@domain #code" line is what lets Android's WebOTP API
    // offer the code straight from the notification, and it must be the last
    // line of the message for the browser to accept it.
    const message = `My Andijan tasdiqlash kodi: ${code}. @myandijan.uz #${code}`;
    if (!(await this.smsService.send(dto.phone, message))) {
      // Undelivered: retire the code so it can never be used, and say so.
      await this.retireCode(issued.id);
      throw new ServiceUnavailableException(SMS_UNAVAILABLE_MESSAGE);
    }

    return { success: true, message: 'Kod yuborildi' };
  }

  async verifyOtp(dto: VerifyOtpDto) {
    const record = await this.checkCode(dto.phone, OtpPurpose.LOGIN, dto.otp);
    // Consume first, atomically: of concurrent requests with the same code,
    // exactly one gets past this line.
    if (!record || !(await this.consumeCode(this.prisma, record.id))) {
      throw new BadRequestException(INVALID_OTP_MESSAGE);
    }

    let user = await this.prisma.user.findUnique({ where: { phone: dto.phone } });

    if (user && (user.deletedAt || user.status !== UserStatus.ACTIVE)) {
      throw new ForbiddenException('Account is not active');
    }

    // Staff never sign in by SMS code alone (Phase 15E.2). The message names
    // no role; it only reaches whoever holds a valid code for this phone.
    if (user && !OTP_LOGIN_ROLES.has(user.role)) {
      throw new ForbiddenException(OTP_LOGIN_UNAVAILABLE_MESSAGE);
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

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date(), phoneVerified: true },
    });

    const tokens = await this.startSession(user);
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

  // ============================================================================
  // CODE LIFECYCLE — shared by OTP sign-in and password reset (Phase 15E.2)
  // ============================================================================

  /** Six digits from the CSPRNG — never Math.random, which is neither uniform nor unpredictable. */
  private generateCode(): string {
    return String(crypto.randomInt(100000, 1000000));
  }

  /**
   * Configuration-level check, made before anything else, so the answer is
   * the same for every phone (no account-existence signal). Without an SMS
   * provider a code could only be delivered by logging it, which is exactly
   * what must never happen.
   */
  private assertSmsAvailable(): void {
    if (!this.smsService.isConfigured) {
      throw new ServiceUnavailableException(SMS_UNAVAILABLE_MESSAGE);
    }
  }

  /**
   * One live code per phone + purpose: every unused code is retired in the
   * same transaction that creates the new one. Retired rows keep their
   * `attempts`, so they still count against the failure budget.
   */
  private async issueCode(phone: string, purpose: OtpPurpose, codeHash: string, expiresAt: Date): Promise<OtpCode> {
    const [, issued] = await this.prisma.$transaction([
      this.prisma.otpCode.updateMany({ where: { phone, purpose, usedAt: null }, data: { usedAt: new Date() } }),
      this.prisma.otpCode.create({ data: { phone, codeHash, purpose, expiresAt } }),
    ]);
    return issued;
  }

  private async retireCode(id: number): Promise<void> {
    await this.prisma.otpCode.updateMany({ where: { id, usedAt: null }, data: { usedAt: new Date() } });
  }

  /**
   * Is `code` the live code for this phone + purpose? Does NOT consume it.
   *
   * - Only the newest unused, unexpired row is ever compared, so superseded
   *   codes give no extra guesses.
   * - Before comparing, one guess is RESERVED atomically against the budget
   *   (failures across every row of the last hour); with the budget spent the
   *   update matches nothing and the code is refused without a comparison.
   * - A correct guess hands its reservation back, so only failures count.
   * - With no live code, or no budget, an equal bcrypt comparison still runs:
   *   the timing does not reveal whether a code was ever issued.
   */
  private async checkCode(phone: string, purpose: OtpPurpose, code: string): Promise<OtpCode | null> {
    const now = new Date();
    const active = await this.prisma.otpCode.findFirst({
      where: { phone, purpose, usedAt: null, expiresAt: { gt: now } },
      orderBy: { createdAt: 'desc' },
    });
    if (!active) {
      await this.equalHashWork(code);
      return null;
    }

    const windowStart = new Date(now.getTime() - CODE_FAILURE_WINDOW_MINUTES * 60 * 1000);
    const earlier = await this.prisma.otpCode.aggregate({
      _sum: { attempts: true },
      where: { phone, purpose, id: { not: active.id }, createdAt: { gte: windowStart } },
    });
    const allowed = MAX_CODE_FAILURES_PER_WINDOW - (earlier._sum.attempts ?? 0);

    const reserved = await this.prisma.otpCode.updateMany({
      where: { id: active.id, usedAt: null, expiresAt: { gt: now }, attempts: { lt: allowed } },
      data: { attempts: { increment: 1 } },
    });
    if (reserved.count === 0) {
      await this.equalHashWork(code);
      return null;
    }

    if (!(await bcrypt.compare(code, active.codeHash))) {
      return null;
    }
    await this.prisma.otpCode.update({ where: { id: active.id }, data: { attempts: { decrement: 1 } } });
    return active;
  }

  /**
   * Atomic single use: a compare-and-set on `usedAt`. Of any number of
   * concurrent callers holding the same valid code, exactly one gets `true`.
   */
  private async consumeCode(client: Pick<Prisma.TransactionClient, 'otpCode'>, id: number): Promise<boolean> {
    const { count } = await client.otpCode.updateMany({
      where: { id, usedAt: null, expiresAt: { gt: new Date() } },
      data: { usedAt: new Date() },
    });
    return count === 1;
  }

  /** The same bcrypt comparison a real code costs, against a hash nothing can match. */
  private async equalHashWork(code: string): Promise<void> {
    this.dummyCodeHash ??= bcrypt.hash(crypto.randomBytes(32).toString('hex'), BCRYPT_ROUNDS);
    await bcrypt.compare(code, await this.dummyCodeHash);
  }

  // ============================================================================
  // PASSWORD RESET
  //
  // Reuses the existing OtpCode model (purpose=PASSWORD_RESET) rather than a
  // new table — it already has codeHash, attempts, expiresAt, usedAt, which
  // is everything this flow needs, and it was sitting unused.
  // ============================================================================

  async forgotPassword(dto: ForgotPasswordDto) {
    this.assertSmsAvailable();
    const user = await this.prisma.user.findUnique({ where: { phone: dto.phone } });

    // Always the same response and the same work whether or not the phone is
    // registered — anything else is a phone-number enumeration oracle. A code
    // is generated and bcrypt-hashed either way; only a real account stores
    // it, and its SMS goes out in the background so delivery latency is not
    // part of the response time either.
    const code = this.generateCode();
    const codeHash = await bcrypt.hash(code, BCRYPT_ROUNDS);
    if (user && !user.deletedAt && user.status === UserStatus.ACTIVE) {
      const expiresAt = new Date(Date.now() + RESET_CODE_TTL_MINUTES * 60 * 1000);
      const issued = await this.issueCode(dto.phone, OtpPurpose.PASSWORD_RESET, codeHash, expiresAt);
      void this.deliverResetCode(dto.phone, code, issued.id);
    }

    return { message: 'Kod yuborildi' };
  }

  /**
   * Sends the reset code; on failure retires it and logs that delivery
   * failed — never the code, never the phone. The response has already gone
   * out with the generic message (answering differently here would reveal
   * that the account exists).
   */
  private async deliverResetCode(phone: string, code: string, codeId: number): Promise<void> {
    const message = `My Andijan parolni tiklash kodi: ${code}. @myandijan.uz #${code}`;
    const sent = await this.smsService.send(phone, message).catch(() => false);
    if (!sent) {
      await this.retireCode(codeId).catch(() => undefined);
      this.logger.error('Password-reset SMS was not delivered; the code was retired');
    }
  }

  async verifyResetCode(dto: VerifyResetCodeDto) {
    const record = await this.checkCode(dto.phone, OtpPurpose.PASSWORD_RESET, dto.code);
    if (!record) {
      throw new BadRequestException(INVALID_RESET_CODE);
    }
    return { valid: true };
  }

  async resetPassword(dto: ResetPasswordDto) {
    const record = await this.checkCode(dto.phone, OtpPurpose.PASSWORD_RESET, dto.code);
    if (!record) {
      throw new BadRequestException(INVALID_RESET_CODE);
    }

    const passwordHash = await bcrypt.hash(dto.newPassword, BCRYPT_ROUNDS);
    const now = new Date();

    // One transaction: consuming the code, the new password, the end of every
    // existing session (every AuthSession and refresh token revoked — 15E.4b;
    // sessionVersion bumped so outstanding access tokens die on their next
    // request) and the security audit row. Whoever held the old credentials — including an attacker —
    // is signed out; the user signs in again with the new password (15B).
    await this.prisma.$transaction(async (tx) => {
      // Atomic single use (15E.2): a concurrent request with the same code
      // loses here, and its whole transaction — password included — rolls back.
      if (!(await this.consumeCode(tx, record.id))) {
        throw new BadRequestException(INVALID_RESET_CODE);
      }
      const user = await tx.user.update({
        where: { phone: dto.phone },
        data: { passwordHash, sessionVersion: { increment: 1 } },
      });
      // The user row is written (and so locked) above, before any session row.
      const revoked = await revokeAllUserSessions(tx, user.id, SessionRevokedReason.PASSWORD_RESET, now);
      await tx.auditLog.create({
        data: {
          ...auditRequestFields(),
          actorId: user.id,
          actorRole: user.role,
          action: AuditAction.UPDATE,
          entityType: 'UserCredentials',
          entityId: user.id,
          before: {} as Prisma.InputJsonValue,
          after: { passwordReset: true, ...revoked } as Prisma.InputJsonValue,
          note: 'Password reset via SMS code',
        },
      });
    });

    return { message: "Parol o'zgartirildi" };
  }

  /**
   * One successful sign-in (password, registration, SMS code) = exactly one
   * new AuthSession with its first refresh token, written together by one
   * nested create. The session's absolute expiry is fixed here and never
   * extended. Only the token's SHA-256 is stored; the raw value exists only
   * in the response.
   */
  private async startSession(user: SessionUser): Promise<TokenPair> {
    const now = new Date();
    const absoluteExpiresAt = new Date(now.getTime() + ABSOLUTE_SESSION_TTL_MS);
    const refreshToken = this.newRefreshToken();

    await this.prisma.authSession.create({
      data: {
        userId: user.id,
        createdAt: now,
        absoluteExpiresAt,
        lastUsedAt: now,
        ...sessionDeviceMetadata(),
        refreshTokens: {
          create: {
            userId: user.id,
            tokenHash: this.hashToken(refreshToken),
            expiresAt: refreshTokenExpiry(now, this.refreshTtlMs(), absoluteExpiresAt),
          },
        },
      },
      select: { id: true },
    });

    return { accessToken: await this.signAccessToken(user), refreshToken };
  }

  private signAccessToken(user: SessionUser): Promise<string> {
    const payload: JwtPayload = { sub: user.id, phone: user.phone, role: user.role, sv: user.sessionVersion };
    return this.jwtService.signAsync(payload, {
      secret: process.env.JWT_ACCESS_SECRET,
      expiresIn: process.env.JWT_ACCESS_EXPIRES_IN ?? '15m',
    });
  }

  /** 48 bytes from the CSPRNG, hex-encoded (96 characters). */
  private newRefreshToken(): string {
    return crypto.randomBytes(48).toString('hex');
  }

  /** The per-token (idle) lifetime; every session is separately capped at 90 days. */
  private refreshTtlMs(): number {
    const base = new Date(0);
    return this.addDuration(base, process.env.JWT_REFRESH_EXPIRES_IN ?? '30d').getTime() - base.getTime();
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

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
