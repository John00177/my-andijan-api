import { slugBase, slugify } from './slug';

// The pre-16F.2 slugify, verbatim (it lived in owner/products/admin services
// and inline in events). Kept here only to prove plain ASCII names still slug
// exactly as before.
function legacySlugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/['’ʻʼ`]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

describe('slugify (Phase 16F.2)', () => {
  describe('Cyrillic is transliterated, not deleted', () => {
    it.each([
      ['Сой миллий таомлар', 'soy-milliy-taomlar'],
      ['Андижон', 'andijon'],
      ['Жиззах', 'jizzax'], // Uzbek: ж → j, х → x
      ['Кўк чой', 'kok-choy'], // ў → o
      ['Қўқон', 'qoqon'], // қ → q
      ['Ғалаба', 'galaba'], // ғ → g
      ['Ҳамза', 'hamza'], // ҳ → h
      ['Цех №5', 'tsex-5'], // ц → ts; х → x (Uzbek Latin), № dropped
      ['Щука', 'shchuka'],
      ['Белый Медведь', 'belyy-medved'], // ь dropped
      ['Ёлка', 'yolka'],
      ['Ер', 'yer'], // е at a word start → ye
      ['Объект', 'obyekt'], // е after ъ → ye
      ['ПЕКАРНЯ «Хлеб»', 'pekarnya-xleb'],
    ])('%s → %s', (name, slug) => {
      expect(slugify(name)).toBe(slug);
    });

    it('gives an Uzbek Cyrillic name the same slug as its Uzbek Latin spelling', () => {
      expect(slugify('Кўк чой')).toBe(slugify("Ko'k choy"));
      expect(slugify('Ғалаба')).toBe(slugify('G‘alaba'));
    });

    it('handles mixed scripts, digits and punctuation', () => {
      expect(slugify('Kafe Ромашка 24/7')).toBe('kafe-romashka-24-7');
    });
  });

  describe('Latin input', () => {
    it.each([
      'Soy milliy taomlar',
      "Ko'k choy",
      'Oʻzbekiston',
      'Gʼijduvon',
      'Osh Markazi #1',
      '  Leading/trailing  ',
      'UPPER lower 123',
      'a---b___c',
    ])('slugs plain ASCII-only names exactly as before: %s', (name) => {
      expect(slugify(name)).toBe(legacySlugify(name));
    });

    it('drops Latin diacritics instead of the whole letter', () => {
      expect(slugify('Café Été')).toBe('cafe-ete');
      expect(slugify('Öz Şeker')).toBe('oz-seker');
    });

    it('also drops the left single quote used for o‘/g‘, like the other apostrophes', () => {
      expect(slugify('O‘zbekiston')).toBe('ozbekiston');
    });
  });

  it('returns an empty string when nothing slug-worthy remains', () => {
    expect(slugify('!!! ***')).toBe('');
    expect(slugify('   ')).toBe('');
  });
});

describe('slugBase', () => {
  it('uses the transliterated name', () => {
    expect(slugBase('Сой', 'business')).toBe('soy');
  });

  it('falls back when the name has no slug-worthy characters', () => {
    expect(slugBase('!!!', 'business')).toBe('business');
    expect(slugBase('', 'event')).toBe('event');
  });

  it.each([
    ['777', 'business', 'business-777'],
    ['2024', 'event', 'event-2024'],
    ['№1', 'business', 'business-1'],
  ])('never returns an all-digit slug — %s (fallback %s) → %s', (name, fallback, slug) => {
    expect(slugBase(name, fallback)).toBe(slug);
  });

  it('keeps digits that are part of a longer slug', () => {
    expect(slugBase('24/7', 'business')).toBe('24-7');
    expect(slugBase('Osh 1', 'business')).toBe('osh-1');
  });
});
