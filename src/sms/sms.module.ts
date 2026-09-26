import { Global, Module } from '@nestjs/common';
import { SmsService } from './sms.service';

/**
 * Global so the token cache in SmsService is a single instance across the
 * app — a per-module copy would mint a separate Eskiz token each.
 */
@Global()
@Module({
  providers: [SmsService],
  exports: [SmsService],
})
export class SmsModule {}
