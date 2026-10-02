import {
  BadRequestException,
  Controller,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ApiConsumes, ApiBody } from '@nestjs/swagger';
import { UploadService } from './upload.service';
import { Authenticated } from '../authz/authz.decorators';

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB — matches the frontend's own stated limit.
const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

@ApiTags('upload')
@Controller('upload')
export class UploadController {
  constructor(private readonly uploadService: UploadService) {}

  // Any authenticated user — the endpoint just returns a public URL and
  // does nothing with it server-side; permission to actually attach that
  // URL to a business/review/menu item is enforced by whichever write
  // endpoint the frontend calls next.
  @ApiBearerAuth()
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } } })
  @Authenticated()
  @Post('image')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_FILE_SIZE },
    }),
  )
  async uploadImage(@UploadedFile() file?: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException('No file uploaded (expected multipart field "file")');
    }
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
      throw new BadRequestException(`Unsupported file type: ${file.mimetype}`);
    }
    return this.uploadService.uploadImage(file);
  }
}
