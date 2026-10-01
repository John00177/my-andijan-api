import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ThrottlerModule } from '@nestjs/throttler';
import { AUTH_THROTTLER_OPTIONS } from './auth-throttle';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtStrategy } from './strategies/jwt.strategy';
import { SmsService } from '../sms/sms.service';
import { UploadService } from '../upload/upload.service';

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.register({
      secret: process.env.JWT_ACCESS_SECRET,
      signOptions: { expiresIn: process.env.JWT_ACCESS_EXPIRES_IN ?? '15m' },
    }),
    // Scoped to this module: only AuthController applies ThrottlerGuard.
    ThrottlerModule.forRoot(AUTH_THROTTLER_OPTIONS),
  ],
  controllers: [AuthController],
  // UploadService is provided directly rather than by importing UploadModule:
  // that module also registers UploadController, and importing it here would
  // mount /upload a second time.
  providers: [AuthService, JwtStrategy, SmsService, UploadService],
  exports: [AuthService],
})
export class AuthModule {}
