import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Put,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { RequestOtpDto } from './dto/request-otp.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';

const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { VerifyResetCodeDto } from './dto/verify-reset-code.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from './strategies/jwt.strategy';
import { SkipThrottle, Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { AUTH_LIMITS } from './auth-throttle';
import { Public, Authenticated } from '../authz/authz.decorators';

// Every credential / SMS-code route is rate limited (Phase 15B) — per client
// address and per target phone; limits and rationale in auth-throttle.ts.
// Exceeding one returns 429. Authenticated profile/logout calls are exempt.
@ApiTags('auth')
@UseGuards(ThrottlerGuard)
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Throttle(AUTH_LIMITS.register)
  @Public()
  @Post('register')
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @Throttle(AUTH_LIMITS.login)
  @HttpCode(HttpStatus.OK)
  @Public()
  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  // Refresh bodies carry no phone; only the per-address bucket applies.
  @Throttle(AUTH_LIMITS.refresh)
  @SkipThrottle({ phone: true })
  @HttpCode(HttpStatus.OK)
  @Public()
  @Post('refresh')
  refresh(@Body() dto: RefreshDto) {
    return this.authService.refresh(dto);
  }

  @SkipThrottle({ ip: true, phone: true })
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Authenticated()
  @Post('logout')
  logout(@Body() dto: RefreshDto, @CurrentUser() _user: AuthenticatedUser) {
    return this.authService.logout(dto.refreshToken);
  }

  @Throttle(AUTH_LIMITS.otpRequest)
  @HttpCode(HttpStatus.OK)
  @Public()
  @Post('otp/request')
  requestOtp(@Body() dto: RequestOtpDto) {
    return this.authService.requestOtp(dto);
  }

  @Throttle(AUTH_LIMITS.otpVerify)
  @HttpCode(HttpStatus.OK)
  @Public()
  @Post('otp/verify')
  verifyOtp(@Body() dto: VerifyOtpDto) {
    return this.authService.verifyOtp(dto);
  }

  @SkipThrottle({ ip: true, phone: true })
  @ApiBearerAuth()
  @ApiConsumes('multipart/form-data')
  @Authenticated()
  @Put('profile')
  @UseInterceptors(
    FileInterceptor('photo', {
      limits: { fileSize: MAX_PHOTO_BYTES },
      fileFilter: (_req, file, cb) => {
        // Rejecting here keeps a non-image from ever reaching storage. The
        // multipart parser still caps size independently via `limits`.
        if (!file.mimetype?.startsWith('image/')) {
          return cb(new BadRequestException('Only image files are accepted'), false);
        }
        cb(null, true);
      },
    }),
  )
  updateProfile(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateProfileDto,
    @UploadedFile() photo?: Express.Multer.File,
  ) {
    return this.authService.updateProfile(user.id, dto, photo);
  }

  @Throttle(AUTH_LIMITS.forgotPassword)
  @HttpCode(HttpStatus.OK)
  @Public()
  @Post('forgot-password')
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.forgotPassword(dto);
  }

  @Throttle(AUTH_LIMITS.verifyResetCode)
  @HttpCode(HttpStatus.OK)
  @Public()
  @Post('verify-reset-code')
  verifyResetCode(@Body() dto: VerifyResetCodeDto) {
    return this.authService.verifyResetCode(dto);
  }

  @Throttle(AUTH_LIMITS.resetPassword)
  @HttpCode(HttpStatus.OK)
  @Public()
  @Post('reset-password')
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto);
  }
}
