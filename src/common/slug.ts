// URL slugs for businesses, branches, events, products and categories
// (Phase 16F.2). Shared so every generator agrees.
//
// Before this, each service had its own ASCII-only slugify that DELETED every
// non-Latin letter: a business named "Сой миллий таомлар" became `business`,
// the next one `business-2`, and so on — meaningless, unsearchable URLs for
// a region where many names are written in Cyrillic. Cyrillic is now
// transliterated instead.
//
// Only NEW slugs are affected: slugs are written once, at creation, and never
// regenerated, so every existing URL keeps working and no migration is needed.

// Uzbek Latin conventions first (ж→j, х→x, ц→ts, қ→q, ғ→g, ў→o, ҳ→h), so a
// name typed in Uzbek Cyrillic slugs the same as its Uzbek Latin spelling
// ("Кўк чой" and "Ko'k choy" both → kok-choy). Russian-only letters use
// common romanisations. Apostrophe-bearing Latin letters (o‘, g‘) lose the
// apostrophe exactly as typed Latin does below.
const CYRILLIC: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', ё: 'yo', ж: 'j', з: 'z', и: 'i', й: 'y',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u',
  ф: 'f', х: 'x', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e',
  ю: 'yu', я: 'ya', ў: 'o', қ: 'q', ғ: 'g', ҳ: 'h', і: 'i', ї: 'yi', є: 'ye', ґ: 'g',
};

// Letters after which Cyrillic `е` is pronounced (and romanised) "ye".
const YE_AFTER = new Set(['а', 'е', 'ё', 'и', 'о', 'у', 'ы', 'э', 'ю', 'я', 'ў', 'ъ', 'ь']);

function transliterate(lower: string): string {
  let out = '';
  for (let i = 0; i < lower.length; i++) {
    const ch = lower[i];
    if (ch === 'е') {
      // "Ер" → yer, "Белорус" → belorus: ye at a word start or after a
      // vowel/sign, e elsewhere — the Uzbek and Russian convention.
      const prev = i > 0 ? lower[i - 1] : '';
      const atWordStart = !prev || !/\p{L}/u.test(prev);
      out += atWordStart || YE_AFTER.has(prev) ? 'ye' : 'e';
      continue;
    }
    out += CYRILLIC[ch] ?? ch;
  }
  return out;
}

/**
 * Lowercase, transliterate Cyrillic, drop Latin diacritics (é → e, ş → s),
 * drop apostrophes (o‘ → o, as before), and join the rest with single
 * hyphens. May return '' (e.g. only punctuation) — callers supply a fallback.
 * For plain ASCII input the result is identical to the old per-service
 * slugify, so Latin names slug exactly as they always have.
 */
export function slugify(input: string): string {
  return (
    transliterate(input.toLowerCase())
      // Cyrillic is already gone; NFD only splits Latin letters from their
      // combining accents, which the next step removes.
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .replace(/['’‘ʻʼ`]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
  );
}

/**
 * The base a unique-slug generator suffixes from. Never empty (falls back to
 * e.g. `business`) and never all digits: GET /businesses/:idOrSlug reads a
 * purely numeric value as an ID, so a business named "777" must not get the
 * slug `777` — it gets `business-777`. Applied to every generator for one
 * consistent rule.
 */
export function slugBase(name: string, fallback: string): string {
  const slug = slugify(name);
  if (!slug) return fallback;
  return /^\d+$/.test(slug) ? `${fallback}-${slug}` : slug;
}
