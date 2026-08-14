-- ============================================================================
-- SEARCH: PostgreSQL full-text search + pg_trgm fuzzy matching
--
-- pg_trgm is a standard contrib module (trusted since PG13), not a proprietary
-- extension — the "relocatable to an Uzbek host" constraint still holds, the
-- target host just needs postgresql-contrib installed.
--
-- Nothing here is modelled in schema.prisma (extension, functions, expression
-- indexes only) so Prisma drift detection stays quiet and no column is added.
--
-- NOTE ON SCHEMA QUALIFICATION: PostgreSQL 17+ executes CREATE INDEX with a
-- restricted search_path (pg_catalog, pg_temp). Every reference below is
-- therefore fully qualified — public.* for our own objects and for
-- gin_trgm_ops, 'pg_catalog.simple' for the text-search config. Dropping the
-- qualification makes index creation fail with "function ... does not exist".
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ----------------------------------------------------------------------------
-- search_normalize: folds Uzbek Cyrillic, Uzbek Latin and the various
-- romanisations onto ONE ascii form, so "Xo'jaobod", "Хўжаобод", "Hojaobod"
-- and "Khodjaobod" all collapse to the same string.
--
-- Must stay IMMUTABLE — the expression indexes below depend on it.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.search_normalize(input text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
WITH s0 AS (
  SELECT lower(coalesce(input, '')) AS v
),
-- Cyrillic letters whose Latin form is longer than one character.
s1 AS (
  SELECT replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(
           v,
           'ё', 'yo'), 'ж', 'j'), 'ц', 'ts'), 'ч', 'ch'), 'ш', 'sh'),
           'щ', 'sh'), 'ю', 'yu'), 'я', 'ya'), 'ъ', ''), 'ь', '') AS v
  FROM s0
),
-- The rest of Cyrillic maps 1:1. Uzbek-specific: ў->o, қ->q, ғ->g, ҳ->h.
s2 AS (
  SELECT translate(v,
           'абвгдезийклмнопрстуфхўқғҳыэ',
           'abvgdeziyklmnoprstufxoqghie') AS v
  FROM s1
),
-- Fold the whole apostrophe family away: oʻ/o'/oʼ -> o, gʻ/g' -> g, masʼul -> masul.
s3 AS (
  SELECT translate(v, 'ʻʼ‘’`´′''', '') AS v FROM s2
),
-- Diacritics used by alternate romanisations (Ō, Ḡ, ...).
s4 AS (
  SELECT translate(v,
           'ōôǒöòóāáàäâéèêëíìîïúùûüñḡğ',
           'ooooooaaaaaeeeeiiiiuuuungg') AS v
  FROM s3
),
-- Spelling variants. 'ch' is parked on a sentinel first, otherwise the c->k
-- fold below would turn it into 'kh' and the kh->h rule would eat it.
s5 AS (
  SELECT replace(replace(replace(v, 'kh', 'h'), 'gh', 'g'), 'ch', chr(1)) AS v
  FROM s4
),
-- x<->h (Xojaobod/Hojaobod), q<->k (Qurghontepa/Kurgontepa), w->v, c->k.
s6 AS (
  SELECT translate(v, 'xqwc', 'hkvk') AS v FROM s5
),
s7 AS (
  SELECT replace(v, chr(1), 'ch') AS v FROM s6
)
-- Everything that is not a letter or digit becomes a single space.
SELECT btrim(regexp_replace(v, '[^a-z0-9]+', ' ', 'g'))
FROM s7;
$$;

-- ----------------------------------------------------------------------------
-- Search documents. 'simple' config on purpose: there is no Uzbek stemmer and
-- the English one mangles Uzbek. Agglutination ("klinika" -> "klinikasi") is
-- handled by prefix matching in search_tsquery instead.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.business_search_doc(p_name text, p_description text)
RETURNS tsvector
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT setweight(to_tsvector('pg_catalog.simple', public.search_normalize(coalesce(p_name, ''))), 'A')
      || setweight(to_tsvector('pg_catalog.simple', public.search_normalize(coalesce(p_description, ''))), 'B');
$$;

CREATE OR REPLACE FUNCTION public.product_search_doc(p_name text)
RETURNS tsvector
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT setweight(to_tsvector('pg_catalog.simple', public.search_normalize(coalesce(p_name, ''))), 'A');
$$;

-- Every token becomes a prefix term, so "osh markaz" finds "Osh Markazi" and
-- "klinika" finds "Klinikasi". Returns NULL for a query with no usable tokens,
-- which makes `doc @@ NULL` false rather than raising.
CREATE OR REPLACE FUNCTION public.search_tsquery(q text)
RETURNS tsquery
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT to_tsquery('pg_catalog.simple', string_agg(quote_literal(tok) || ':*', ' & '))
  FROM unnest(string_to_array(public.search_normalize(q), ' ')) AS tok
  WHERE tok <> '';
$$;

-- ----------------------------------------------------------------------------
-- Indexes. Expressions must match the query verbatim to be used.
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS businesses_search_doc_idx
  ON businesses USING GIN (public.business_search_doc(name, description));

CREATE INDEX IF NOT EXISTS businesses_name_trgm_idx
  ON businesses USING GIN (public.search_normalize(name) public.gin_trgm_ops);

CREATE INDEX IF NOT EXISTS products_search_doc_idx
  ON products USING GIN (public.product_search_doc(name));

CREATE INDEX IF NOT EXISTS products_name_trgm_idx
  ON products USING GIN (public.search_normalize(name) public.gin_trgm_ops);
