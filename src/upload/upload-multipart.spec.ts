import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { readFileSync } from 'fs';
import { AddressInfo } from 'node:net';
import { join } from 'path';
import { UploadController } from './upload.controller';
import { UploadService } from './upload.service';

// Phase 15 closeout: multipart parsing is done by multer, pulled in by
// @nestjs/platform-express (which pins multer 2.0.2 — several HIGH
// denial-of-service advisories, fixed in 2.3.x). package.json overrides it.
// These tests keep that override from silently regressing and prove, over
// real HTTP, that uploads still parse with the overridden version.

const MULTER_FLOOR = [2, 3, 0];

function atLeast(version: string, floor: number[]): boolean {
  const parts = version.split(/[.-]/).slice(0, 3).map(Number);
  for (let i = 0; i < floor.length; i++) {
    if (parts[i] !== floor[i]) return parts[i] > floor[i];
  }
  return true;
}

describe('Multipart uploads (Phase 15 closeout)', () => {
  it(`the installed multer is at least ${MULTER_FLOOR.join('.')} (the override is in effect)`, () => {
    const { version } = JSON.parse(readFileSync(join(require.resolve('multer'), '..', 'package.json'), 'utf8')) as {
      version: string;
    };
    expect({ version, atLeastFloor: atLeast(version, MULTER_FLOOR) }).toEqual({ version, atLeastFloor: true });
  });

  describe('POST /upload/image over real HTTP (UploadService stubbed)', () => {
    let app: INestApplication;
    let base: string;
    const uploadImage = jest.fn(async (_file: Express.Multer.File) => ({ url: 'https://example.test/x.png' }));

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        controllers: [UploadController],
        providers: [{ provide: UploadService, useValue: { uploadImage } }],
      }).compile();
      app = moduleRef.createNestApplication();
      await app.listen(0, '127.0.0.1');
      base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    });

    afterAll(async () => {
      await app.close();
    });

    beforeEach(() => uploadImage.mockClear());

    const post = (form: FormData) => fetch(`${base}/upload/image`, { method: 'POST', body: form });

    it('parses an image upload and hands the file to the service', async () => {
      const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
      const form = new FormData();
      form.append('file', new Blob([png], { type: 'image/png' }), 'photo.png');

      const res = await post(form);

      expect(res.status).toBe(201);
      expect(uploadImage).toHaveBeenCalledTimes(1);
      const file = uploadImage.mock.calls[0][0];
      expect(file.mimetype).toBe('image/png');
      expect(file.originalname).toBe('photo.png');
      expect(Buffer.compare(file.buffer, png)).toBe(0);
    });

    it('still enforces the 5 MB limit', async () => {
      const form = new FormData();
      form.append('file', new Blob([Buffer.alloc(5 * 1024 * 1024 + 1)], { type: 'image/png' }), 'big.png');

      const res = await post(form);

      expect(res.status).toBe(413);
      expect(uploadImage).not.toHaveBeenCalled();
    });

    it('still refuses a non-image type', async () => {
      const form = new FormData();
      form.append('file', new Blob(['<html></html>'], { type: 'text/html' }), 'x.html');

      const res = await post(form);

      expect(res.status).toBe(400);
      expect(uploadImage).not.toHaveBeenCalled();
    });
  });
});
