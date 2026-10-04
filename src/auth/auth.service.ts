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
import { auditRequestFields, getRequestContext } from '../common/request-context/request-context';
import { capabilitiesFor } from '../authz/capabilities';
import {
  ABSOLUTE_SESSION_TTL_MS,
  classifyRotatedPresentation,
  isWithinRefreshGraceWindow,
  refreshTokenExpiry,
  revokeAllUserSessions,
  revokeSessionForReuse,
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
// Who may sign in, or reset a password, with an SMS code alone (Phase 15E.2;
// password reset since the Phase 15 closeout). An allowlist, so any role added
// later is refused by default: staff (SUPPORT, MODERATOR, ADMIN, SUPER_ADMIN)
// must use their password — an SMS code (SIM swap, intercepted SMS) is not a
// sufficient factor to take over a privileged account. Staff recover
// credentials out of band, never through the public reset flow.
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

/**
 * Thrown inside a refresh transaction to roll ALL of it back; becomes the
 * generic 401. `race` marks a harmless grace-window race (15E.4c), logged with
 * IDs only after the rollback.
 */
class RefreshRejected extends Error {
  constructor(readonly race?: { sessionId: number; tokenId: number }) {
    super();
  }
}

/** A rotation that committed: the one successor. */
type Rotated = { kind: 'rotated'; user: User; refreshToken: string; sessionId: number };
/** Reuse that committed its session revocation (15E.4c); still the generic 401. */
type ReuseDetected = { kind: 'reuse'; sessionId: number; tokenId: number; userId: number };

/** Thrown inside a logout transaction to roll back a revocation the token is not entitled to. */
class LogoutNotEntitled extends Error {}

const LOGOUT_TOKEN_SELECT = Prisma.validator<Prisma.RefreshTokenSelect>()({
  id: true,
  sessionId: true,
  rotatedAt: true,
  revokedAt: true,
  expiresAt: true,
  successor: { select: { rotatedAt: true } },
  user: { select: { id: true, role: true } },
});

/**
 * May this token end its session (see AuthService.logout)? The current token
 * may; a rotated one only inside the grace window with its successor unused.
 * A token revoked without rotation (logout, reset, suspension) or expired may not.
 */
function mayEndSession(
  token: Prisma.RefreshTokenGetPayload<{ select: typeof LOGOUT_TOKEN_SELECT }>,
  now: Date,
): boolean {
  if (token.rotatedAt) return isWithinRefreshGraceWindow(token, token.successor, now);
  return token.revokedAt === null && token.expiresAt > now;
}

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
   * Race-safe rotation (Phase 15E.4b) with reuse detection (Phase 15E.4c).
   * One transaction; see refresh-sessions.ts for the locking model. Of any
   * number of concurrent requests presenting the same token, exactly one gets
   * a successor.
   *
   * A token that was already rotated NEVER yields a successor. While its
   * session is live it is classified under the session lock:
   *   - harmless race (inside the grace window, successor unused): 401, the
   *     session is left alone, everything rolls back;
   *   - reuse (anything else): this session and all its tokens are revoked
   *     (REUSE_DETECTED) and audited — committed — then the same 401.
   * Every failure answers identically, so the caller cannot tell reuse from
   * expiry, revocation or an unknown token.
   */
  async refresh(dto: RefreshDto) {
    const tokenHash = this.hashToken(dto.refreshToken);
    let outcome: Rotated | ReuseDetected;
    try {
      outcome = await this.prisma.$transaction((tx) => this.rotateRefreshToken(tx, tokenHash));
    } catch (error) {
      if (error instanceof RefreshRejected) {
        if (error.race) {
          this.logger.log(
            `Refresh grace-window race refused (session=${error.race.sessionId} token=${error.race.tokenId} request=${requestIdForLog()})`,
          );
        }
        throw new UnauthorizedException(INVALID_REFRESH_MESSAGE);
      }
      // P2002 is the parent_id UNIQUE backstop refusing a second successor —
      // unreachable while the locking below is correct, and a plain 401 if not.
      if (isUniqueViolation(error)) throw new UnauthorizedException(INVALID_REFRESH_MESSAGE);
      throw error;
    }
    if (outcome.kind === 'reuse') {
      this.logger.warn(
        `Refresh-token reuse detected; session revoked (session=${outcome.sessionId} token=${outcome.tokenId} user=${outcome.userId} request=${requestIdForLog()})`,
      );
      throw new UnauthorizedException(INVALID_REFRESH_MESSAGE);
    }
    const accessToken = await this.signAccessToken(outcome.user, outcome.sessionId);
    return { user: this.sanitizeUser(outcome.user), accessToken, refreshToken: outcome.refreshToken };
  }

  private async rotateRefreshToken(tx: Prisma.TransactionClient, tokenHash: string): Promise<Rotated | ReuseDetected> {
    const now = new Date();

    // 1. Locate the token. No lock yet: this read decides only which session
    //    to lock, never whether to rotate.
    const presented = await tx.refreshToken.findUnique({
      where: { tokenHash },
      select: { id: true, sessionId: true },
    });
    if (!presented) throw new RefreshRejected();
    // Every token has a session (session_id NOT NULL since Phase 15E.4e.1).
    const sessionId = presented.sessionId;

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
    //    for every other one the count is 0. revokedAt is set as well:
    //    `revokedAt IS NULL` is the one "still usable" test every other path
    //    (logout, every revocation, this CAS) relies on, so a rotated token is
    //    dead to all of them without each having to know about rotatedAt.
    const cas = await tx.refreshToken.updateMany({
      where: { id: presented.id, sessionId, rotatedAt: null, revokedAt: null, expiresAt: { gt: now } },
      data: { rotatedAt: now, revokedAt: now },
    });
    if (cas.count !== 1) {
      // Not the current token. Still holding the session lock (the session is
      // live): rotated → harmless race or reuse; otherwise plain refusal.
      return this.handleRotatedPresentation(tx, presented.id, sessionId, session.userId, now);
    }

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
    return { kind: 'rotated', user, refreshToken, sessionId };
  }

  /**
   * Reuse detection (Phase 15E.4c). Runs only after the compare-and-set
   * failed, while this transaction holds the live session's row lock — so
   * every other writer of the session (rotation of the successor, logout,
   * another detection, password reset, suspension) is serialized with it.
   * The token is re-read in a fresh statement and judged on a clock read
   * AFTER that re-read (a rotation that just committed was stamped by another
   * request's clock).
   */
  private async handleRotatedPresentation(
    tx: Prisma.TransactionClient,
    tokenId: number,
    sessionId: number,
    userId: number,
    now: Date,
  ): Promise<ReuseDetected> {
    const token = await tx.refreshToken.findUniqueOrThrow({
      where: { id: tokenId },
      select: { rotatedAt: true, successor: { select: { rotatedAt: true } } },
    });
    const checkedAt = new Date();
    const verdict = classifyRotatedPresentation(token, token.successor, checkedAt);
    if (verdict === 'not-rotated') throw new RefreshRejected(); // expired or revoked: not reuse
    if (verdict === 'benign-race') throw new RefreshRejected({ sessionId, tokenId }); // rolls back, session untouched

    // Reuse: end this session — never another one, never sessionVersion — and
    // commit that, then answer with the same 401 as any failure.
    const revoked = await revokeSessionForReuse(tx, sessionId, now);
    if (!revoked.sessionRevoked) throw new RefreshRejected(); // unreachable: we hold the live session's lock
    const owner = await tx.user.findUnique({ where: { id: userId }, select: { role: true } });
    await tx.auditLog.create({
      data: {
        ...auditRequestFields(),
        actorId: userId,
        actorRole: owner?.role ?? null,
        action: AuditAction.UPDATE,
        entityType: 'AuthSession',
        entityId: sessionId,
        before: { revoked: false } as Prisma.InputJsonValue,
        after: {
          revoked: true,
          reason: SessionRevokedReason.REUSE_DETECTED,
          tokensRevoked: revoked.tokensRevoked,
          presentedTokenId: tokenId,
          successorUsed: Boolean(token.successor?.rotatedAt),
          rotatedAgoMs: checkedAt.getTime() - token.rotatedAt!.getTime(),
        } as Prisma.InputJsonValue,
        note: 'Refresh-token reuse detected — session revoked',
      },
    });
    return { kind: 'reuse', sessionId, tokenId, userId };
  }

  /**
   * Ends the whole session the presented refresh token belongs to (Phase
   * 15E.4b). Possession of the token is the proof — no access token is
   * needed, so sign-out works after the access token has expired. The
   * response is the same in every case.
   *
   * The token may end its session only while it is:
   *   - the session's CURRENT token (not rotated, not revoked, not expired), or
   *   - its immediate predecessor, rotated within the refresh grace window and
   *     with the successor still unused. That is the client signing out while
   *     its own refresh was in flight: the server has already rotated, but the
   *     client never stored (and now discards) the successor. Refusing would
   *     leave that successor and its session alive after "logout".
   * Any older token — rotated longer ago, or whose successor has been used —
   * ends nothing: an old token must not be enough to end someone's session,
   * and what a replayed token should trigger is decided in 15E.4c.
   */
  async logout(refreshToken: string) {
    const tokenHash = this.hashToken(refreshToken);
    const now = new Date();
    try {
      await this.prisma.$transaction((tx) => this.endSessionOnLogout(tx, tokenHash, now));
    } catch (error) {
      if (!(error instanceof LogoutNotEntitled)) throw error;
    }
    return { success: true };
  }

  private async endSessionOnLogout(tx: Prisma.TransactionClient, tokenHash: string, now: Date): Promise<void> {
    const presented = await tx.refreshToken.findUnique({ where: { tokenHash }, select: LOGOUT_TOKEN_SELECT });
    // Unlocked, a "no" is already final: entitlement only ever runs out
    // (time passes, a successor gets used), so nothing can make it "yes" again.
    // Judged on a clock read AFTER the token: a refresh that committed just
    // before stamped rotatedAt with its own, possibly later, `now`.
    if (!presented || !mayEndSession(presented, new Date())) return;
    const sessionId = presented.sessionId;

    // Lock and revoke the session row first: a refresh in flight on this
    // session finishes before we continue (lock order: session, then tokens).
    const session = await tx.authSession.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: now, revokedReason: SessionRevokedReason.LOGOUT },
    });
    if (session.count !== 1) return; // already revoked

    // Decide under the lock, on a fresh clock: the token may have been rotated,
    // and its successor used, while we waited. Not entitled → roll back.
    const current = await tx.refreshToken.findUniqueOrThrow({ where: { id: presented.id }, select: LOGOUT_TOKEN_SELECT });
    if (!mayEndSession(current, new Date())) throw new LogoutNotEntitled();

    // A fresh snapshot: includes any successor the waited-for refresh committed.
    const tokens = await tx.refreshToken.updateMany({
      where: { sessionId, revokedAt: null },
      data: { revokedAt: now },
    });
    await tx.auditLog.create({
      data: {
        ...auditRequestFields(),
        actorId: presented.user.id,
        actorRole: presented.user.role,
        action: AuditAction.UPDATE,
        entityType: 'AuthSession',
        entityId: sessionId,
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
    // part of the response time either. A staff account gets no code at all
    // (OTP_LOGIN_ROLES) — answered exactly like an unknown phone, so the
    // response says nothing about the account's role.
    const code = this.generateCode();
    const codeHash = await bcrypt.hash(code, BCRYPT_ROUNDS);
    if (user && !user.deletedAt && user.status === UserStatus.ACTIVE && OTP_LOGIN_ROLES.has(user.role)) {
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
      // Defense in depth: forgotPassword never issues a code to staff, but a
      // code issued before the account became staff must not reset it either.
      // Same generic refusal as a wrong code; the whole transaction rolls back.
      const target = await tx.user.findUnique({ where: { phone: dto.phone } });
      if (!target || !OTP_LOGIN_ROLES.has(target.role)) {
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

    const session = await this.prisma.authSession.create({
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

    return { accessToken: await this.signAccessToken(user, session.id), refreshToken };
  }

  /**
   * The one place access tokens are minted. `sid` binds the token to its
   * AuthSession (Phase 15E.4d.1), so revoking or expiring that session ends
   * the token at once (JwtStrategy). It is required here, so no sign-in or
   * refresh path can issue a token without it. The lifetime stays
   * JWT_ACCESS_EXPIRES_IN, independent of the session's absolute expiry.
   */
  private signAccessToken(user: SessionUser, sessionId: number): Promise<string> {
    const payload: JwtPayload = {
      sub: user.id,
      phone: user.phone,
      role: user.role,
      sv: user.sessionVersion,
      sid: sessionId,
    };
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

/** The server-generated request id, for log lines (never the token, hash, IP or user agent). */
function requestIdForLog(): string {
  return getRequestContext()?.requestId ?? '-';
}
