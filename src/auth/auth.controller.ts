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
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from './strategies/jwt.strategy';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @HttpCode(HttpStatus.OK)
  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @HttpCode(HttpStatus.OK)
  @Post('refresh')
  refresh(@Body() dto: RefreshDto) {
    return this.authService.refresh(dto);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('logout')
  logout(@Body() dto: RefreshDto, @CurrentUser() _user: AuthenticatedUser) {
    return this.authService.logout(dto.refreshToken);
  }

  @HttpCode(HttpStatus.OK)
  @Post('otp/request')
  requestOtp(@Body() dto: RequestOtpDto) {
    return this.authService.requestOtp(dto);
  }

  @HttpCode(HttpStatus.OK)
  @Post('otp/verify')
  verifyOtp(@Body() dto: VerifyOtpDto) {
    return this.authService.verifyOtp(dto);
  }

  @ApiBearerAuth()
  @ApiConsumes('multipart/form-data')
  @UseGuards(JwtAuthGuard)
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

  @HttpCode(HttpStatus.OK)
  @Post('forgot-password')
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.forgotPassword(dto);
  }

  @HttpCode(HttpStatus.OK)
  @Post('verify-reset-code')
  verifyResetCode(@Body() dto: VerifyResetCodeDto) {
    return this.authService.verifyResetCode(dto);
  }

  @HttpCode(HttpStatus.OK)
  @Post('reset-password')
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto);
  }
}
