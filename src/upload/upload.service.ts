import { BadRequestException, Injectable, InternalServerErrorException } from '@nestjs/common';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

const BUCKET = 'myandijan-images';

// Built for cover photos, menu item photos, and review photos — every place
// in the app currently asks the owner/customer to paste an image URL by
// hand. This gives the frontend a real upload path instead.
@Injectable()
export class UploadService {
  private readonly client: SupabaseClient;

  constructor() {
    const url = process.env.SUPABASE_URL;
    // service_role, not anon — this runs server-side only and never reaches
    // the client. The anon key made every upload fail with "new row
    // violates row-level security policy": it's meant for direct
    // browser-to-Supabase calls under RLS, and this backend has no Supabase
    // Auth session for RLS to authorize. service_role bypasses RLS
    // entirely, which is the correct trust boundary for a backend that's
    // already the one deciding (via the global AuthzGuard) who's allowed to upload.
    const key = process.env.SUPABASE_SERVICE_KEY;
    if (!url || !key) {
      throw new InternalServerErrorException('Image upload is not configured (missing SUPABASE_URL/SUPABASE_SERVICE_KEY)');
    }
    // Built once per process, not per request — the client is stateless
    // aside from the fixed URL/key, so there's nothing to gain from
    // recreating it on every upload.
    this.client = createClient(url, key);
  }

  async uploadImage(file: Express.Multer.File): Promise<{ url: string }> {
    // Strip anything but alphanumerics/dot/dash/underscore from the original
    // name — it lands directly in a storage object key and the client fully
    // controls its value.
    const safeName = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    const filename = `${Date.now()}-${safeName}`;

    const { error } = await this.client.storage.from(BUCKET).upload(filename, file.buffer, {
      contentType: file.mimetype,
    });
    if (error) {
      throw new BadRequestException(error.message);
    }

    const { data: urlData } = this.client.storage.from(BUCKET).getPublicUrl(filename);
    return { url: urlData.publicUrl };
  }
}
