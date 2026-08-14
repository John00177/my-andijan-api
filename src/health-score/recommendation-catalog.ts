import { BusinessFacts } from './health-score.types';

// ============================================================================
// RECOMMENDATION CATALOG
//
// Every recommendation the engine can emit, as data. Each entry pairs display
// copy with a `detect` predicate that decides whether the gap ACTUALLY exists
// for this business.
//
// The predicate is the important part. A category score below the threshold
// only says "this area is weak" — it does not say which specific thing is
// missing. Emitting "Add a cover photo" to a business that already has one
// would be worse than saying nothing, so the low-score check merely opens the
// gate and `detect` decides what actually gets shown.
// ============================================================================

export type RecommendationType = 'PROFILE' | 'ENGAGEMENT' | 'VISIBILITY' | 'RESPONSE';
export type RecommendationPriority = 'HIGH' | 'MEDIUM' | 'LOW';

export interface RecommendationRule {
  // Stable key persisted on the row — see the `code` comment in schema.prisma.
  code: string;
  type: RecommendationType;
  priority: RecommendationPriority;
  titleUz: string;
  titleRu: string;
  titleEn: string;
  descriptionUz: string;
  descriptionRu: string;
  descriptionEn: string;
  actionTextUz: string;
  actionTextRu: string;
  actionTextEn: string;
  impactUz: string;
  impactRu: string;
  impactEn: string;
  // Deep link into the owner dashboard. `:id` is replaced with the business id.
  actionUrl: string | null;
  detect: (f: BusinessFacts) => boolean;
}

// Impact figures are directional product estimates, not measured lift — there
// is no experiment framework yet. They are deliberately phrased as ranges the
// product is willing to stand behind.
export const RECOMMENDATION_RULES: RecommendationRule[] = [
  // ---- PROFILE ----------------------------------------------------------------
  {
    code: 'PROFILE_COVER_PHOTO',
    type: 'PROFILE',
    priority: 'HIGH',
    titleUz: "Profil rasmini qo'shing",
    titleRu: 'Добавьте фото профиля',
    titleEn: 'Add a cover photo',
    descriptionUz:
      "Muqova rasmi — qidiruv natijalarida mijoz ko'radigan birinchi narsa. Rasmsiz kartochkalar deyarli har doim e'tiborsiz qoladi.",
    descriptionRu:
      'Обложка — первое, что видит клиент в результатах поиска. Карточки без фото почти всегда пролистывают мимо.',
    descriptionEn:
      'The cover photo is the first thing a customer sees in search results. Listings without one are almost always scrolled past.',
    actionTextUz: "Rasm qo'shing",
    actionTextRu: 'Добавьте фото',
    actionTextEn: 'Add photos',
    impactUz: "+35% ko'rishlar",
    impactRu: '+35% просмотров',
    impactEn: '+35% views',
    actionUrl: '/dashboard/businesses/:id/edit#cover',
    detect: (f) => !f.hasCover,
  },
  {
    code: 'PROFILE_BRANCH_PHOTOS',
    type: 'PROFILE',
    priority: 'HIGH',
    titleUz: "Filial rasmlarini qo'shing",
    titleRu: 'Добавьте фото филиалов',
    titleEn: 'Add branch photos',
    descriptionUz:
      "Kamida 3 ta rasm qo'shing: ichki ko'rinish, tashqi ko'rinish va mahsulot. Mijoz kelishdan oldin joyni ko'rishni xohlaydi.",
    descriptionRu:
      'Добавьте хотя бы 3 фото: интерьер, фасад и продукцию. Клиент хочет увидеть место до того, как придёт.',
    descriptionEn:
      'Add at least 3 photos: interior, exterior, and what you sell. Customers want to see the place before they visit.',
    actionTextUz: "Rasm qo'shing",
    actionTextRu: 'Добавьте фото',
    actionTextEn: 'Add photos',
    impactUz: '+28% aloqa',
    impactRu: '+28% обращений',
    impactEn: '+28% contacts',
    actionUrl: '/dashboard/businesses/:id/branches',
    detect: (f) => f.photoCount < 3,
  },
  {
    code: 'PROFILE_DESCRIPTION',
    type: 'PROFILE',
    priority: 'MEDIUM',
    titleUz: "To'liq tavsif yozing",
    titleRu: 'Напишите полное описание',
    titleEn: 'Write a fuller description',
    descriptionUz:
      "Kamida 200 ta belgi yozing — nima taklif qilasiz, nima bilan ajralib turasiz. Bu qidiruvda topilishga ham yordam beradi.",
    descriptionRu:
      'Напишите минимум 200 символов — что вы предлагаете и чем отличаетесь. Это также помогает вас находить в поиске.',
    descriptionEn:
      'Write at least 200 characters — what you offer and what makes you different. It also helps you surface in search.',
    actionTextUz: 'Tavsifni yangilang',
    actionTextRu: 'Обновите описание',
    actionTextEn: 'Update description',
    impactUz: '+18% qidiruvda topilish',
    impactRu: '+18% находимость в поиске',
    impactEn: '+18% search discovery',
    actionUrl: '/dashboard/businesses/:id/edit#description',
    detect: (f) => f.descriptionLength <= 200,
  },
  {
    code: 'PROFILE_TELEGRAM',
    type: 'PROFILE',
    priority: 'MEDIUM',
    titleUz: "Telegram havolasini qo'shing",
    titleRu: 'Добавьте Telegram',
    titleEn: 'Add Telegram link',
    descriptionUz:
      "O'zbekistonda mijozlarning ko'pchiligi Telegram orqali bog'lanishni afzal ko'radi. Havola qo'shish bir daqiqa vaqt oladi.",
    descriptionRu:
      'В Узбекистане большинство клиентов предпочитают связываться через Telegram. Добавление ссылки займёт минуту.',
    descriptionEn:
      'In Uzbekistan most customers prefer to get in touch over Telegram. Adding the link takes a minute.',
    actionTextUz: "Telegram qo'shing",
    actionTextRu: 'Добавить Telegram',
    actionTextEn: 'Add Telegram',
    impactUz: '+24% aloqa',
    impactRu: '+24% обращений',
    impactEn: '+24% contacts',
    actionUrl: '/dashboard/businesses/:id/edit#contacts',
    detect: (f) => !f.hasTelegram,
  },
  {
    code: 'PROFILE_HOURS',
    type: 'PROFILE',
    priority: 'MEDIUM',
    titleUz: 'Ish vaqtini belgilang',
    titleRu: 'Укажите часы работы',
    titleEn: 'Set your opening hours',
    descriptionUz:
      "Ish vaqti ko'rsatilmagan filiallar bor. Mijozlar ochiqligini bilmasa, boshqa joyni tanlaydi.",
    descriptionRu:
      'У некоторых филиалов не указаны часы работы. Если клиент не знает, открыты ли вы, он выберет другое место.',
    descriptionEn:
      'Some of your branches have no opening hours. If customers cannot tell whether you are open, they pick someone else.',
    actionTextUz: 'Ish vaqtini kiriting',
    actionTextRu: 'Указать часы',
    actionTextEn: 'Set hours',
    impactUz: '+20% tashrif',
    impactRu: '+20% визитов',
    impactEn: '+20% visits',
    actionUrl: '/dashboard/businesses/:id/branches',
    detect: (f) => f.branchCount === 0 || f.branchesWithoutHours > 0,
  },
  {
    code: 'PROFILE_LANDMARK',
    type: 'PROFILE',
    priority: 'LOW',
    titleUz: "Mo'ljal qo'shing",
    titleRu: 'Добавьте ориентир',
    titleEn: 'Add a landmark',
    descriptionUz:
      "Andijonda manzil ko'pincha mo'ljal bilan tushuntiriladi — \"Bozor yonida\" kabi. Bu mijozga sizni topishga yordam beradi.",
    descriptionRu:
      'В Андижане адрес часто объясняют ориентиром — например «рядом с базаром». Это помогает клиенту вас найти.',
    descriptionEn:
      'In Andijan an address is usually explained by a landmark — "next to the bazaar". It helps customers actually find you.',
    actionTextUz: "Mo'ljal kiriting",
    actionTextRu: 'Добавить ориентир',
    actionTextEn: 'Add landmark',
    impactUz: '+12% tashrif',
    impactRu: '+12% визитов',
    impactEn: '+12% visits',
    actionUrl: '/dashboard/businesses/:id/branches',
    detect: (f) => f.branchCount > 0 && f.branchesWithoutLandmark > 0,
  },

  // ---- ENGAGEMENT -------------------------------------------------------------
  {
    code: 'ENGAGEMENT_REPLY_TO_REVIEWS',
    type: 'ENGAGEMENT',
    priority: 'HIGH',
    titleUz: 'Mijozlarga javob bering',
    titleRu: 'Отвечайте клиентам',
    titleEn: 'Reply to reviews',
    descriptionUz:
      "Javobsiz sharhlaringiz bor. Javob bergan biznes mijoz nazarida ancha ishonchli ko'rinadi — hatto salbiy sharhga javob ham foyda beradi.",
    descriptionRu:
      'У вас есть отзывы без ответа. Бизнес, который отвечает, выглядит намного надёжнее — даже ответ на негативный отзыв работает в плюс.',
    descriptionEn:
      'You have reviews with no reply. A business that answers looks far more trustworthy — even replying to a negative review helps.',
    actionTextUz: 'Sharhlarga javob bering',
    actionTextRu: 'Ответить на отзывы',
    actionTextEn: 'Reply to reviews',
    impactUz: '+50% ishonch',
    impactRu: '+50% доверия',
    impactEn: '+50% trust',
    actionUrl: '/dashboard/reviews',
    detect: (f) => f.reviewCount > 0 && f.replyCount < f.reviewCount,
  },
  {
    code: 'ENGAGEMENT_GET_FIRST_REVIEWS',
    type: 'ENGAGEMENT',
    priority: 'HIGH',
    titleUz: "Birinchi sharhlarni to'plang",
    titleRu: 'Соберите первые отзывы',
    titleEn: 'Collect your first reviews',
    descriptionUz:
      "Hali sharh yo'q. Doimiy mijozlaringizdan sharh qoldirishni so'rang — bu reytingga ta'sir qiladigan eng tez yo'l.",
    descriptionRu:
      'Отзывов пока нет. Попросите постоянных клиентов оставить отзыв — это самый быстрый способ повлиять на рейтинг.',
    descriptionEn:
      'You have no reviews yet. Ask your regulars to leave one — it is the fastest lever you have on your rating.',
    actionTextUz: "Sharh so'rang",
    actionTextRu: 'Попросить отзыв',
    actionTextEn: 'Request reviews',
    impactUz: '+45% ishonch',
    impactRu: '+45% доверия',
    impactEn: '+45% trust',
    actionUrl: '/dashboard/businesses/:id',
    detect: (f) => f.reviewCount === 0,
  },
  {
    code: 'ENGAGEMENT_UPDATE_PRICES',
    type: 'ENGAGEMENT',
    priority: 'MEDIUM',
    titleUz: "Boshlang'ich narxni yangilang",
    titleRu: 'Обновите цены',
    titleEn: 'Update your prices',
    descriptionUz:
      "Katalogingiz bo'sh. Narxlar ko'rsatilgan bo'lsa, mijoz qo'ng'iroq qilishdan oldin qaror qabul qiladi va ko'proq murojaat keladi.",
    descriptionRu:
      'Ваш каталог пуст. Когда цены указаны, клиент принимает решение ещё до звонка — и обращений становится больше.',
    descriptionEn:
      'Your catalog is empty. When prices are visible, customers decide before they call — and more of them do.',
    actionTextUz: 'Narxlarni kiriting',
    actionTextRu: 'Указать цены',
    actionTextEn: 'Add prices',
    impactUz: '+16% murojaat',
    impactRu: '+16% обращений',
    impactEn: '+16% enquiries',
    actionUrl: '/dashboard/businesses/:id/products',
    detect: (f) => f.productCount === 0,
  },

  // ---- VISIBILITY -------------------------------------------------------------
  {
    code: 'VISIBILITY_BUY_PROMOTION',
    type: 'VISIBILITY',
    priority: 'HIGH',
    titleUz: 'Reklama xizmatini sotib oling',
    titleRu: 'Купите продвижение',
    titleEn: 'Buy promotion',
    descriptionUz:
      "Reklama qidiruv natijalari va bosh sahifada yuqoriga chiqaradi. Raqobat yuqori toifalarda bu eng tez ishlaydigan usul.",
    descriptionRu:
      'Продвижение поднимает вас выше в поиске и на главной. В конкурентных категориях это самый быстрый рычаг.',
    descriptionEn:
      'Promotion lifts you up the search results and onto the homepage. In competitive categories it is the fastest lever.',
    actionTextUz: 'Reklamani ko\'ring',
    actionTextRu: 'Посмотреть тарифы',
    actionTextEn: 'View promotion',
    impactUz: "+300% ko'rishlar",
    impactRu: '+300% просмотров',
    impactEn: '+300% views',
    actionUrl: '/dashboard/businesses/:id/promote',
    detect: (f) => !f.isPromoted,
  },
  {
    code: 'VISIBILITY_ADD_EVENTS',
    type: 'VISIBILITY',
    priority: 'MEDIUM',
    titleUz: "Tadbirlarni qo'shing",
    titleRu: 'Добавьте события',
    titleEn: 'Add events',
    descriptionUz:
      "Aksiya, ochilish yoki mahsulot taqdimoti — tadbirlar sizni tadbirlar bo'limida va shahar afishasida ko'rsatadi.",
    descriptionRu:
      'Акция, открытие или презентация — события показывают вас в разделе событий и в городской афише.',
    descriptionEn:
      'A promotion, an opening, a product launch — events place you in the events feed and the city listing.',
    actionTextUz: "Tadbir qo'shing",
    actionTextRu: 'Добавить событие',
    actionTextEn: 'Add an event',
    impactUz: "+22% ko'rinish",
    impactRu: '+22% видимости',
    impactEn: '+22% visibility',
    actionUrl: '/dashboard/events/new',
    detect: (f) => f.eventCount === 0,
  },
  {
    code: 'VISIBILITY_GET_VERIFIED',
    type: 'VISIBILITY',
    priority: 'MEDIUM',
    titleUz: 'Tasdiqlangan belgini oling',
    titleRu: 'Получите значок подтверждения',
    titleEn: 'Get verified',
    descriptionUz:
      "Tasdiqlangan belgi qidiruv natijalarida ishonch beradi va reytingda yuqoriroq turishga yordam beradi.",
    descriptionRu:
      'Значок подтверждения вызывает доверие в результатах поиска и помогает ранжироваться выше.',
    descriptionEn:
      'The verified badge builds trust in search results and helps you rank higher.',
    actionTextUz: 'Tasdiqlashni so\'rang',
    actionTextRu: 'Запросить подтверждение',
    actionTextEn: 'Request verification',
    impactUz: '+15% ishonch',
    impactRu: '+15% доверия',
    impactEn: '+15% trust',
    actionUrl: '/dashboard/businesses/:id/verify',
    detect: (f) => !f.isVerified,
  },

  // ---- RESPONSE ---------------------------------------------------------------
  {
    code: 'RESPONSE_REPLY_WITHIN_24H',
    type: 'RESPONSE',
    priority: 'HIGH',
    titleUz: '24 soat ichida javob bering',
    titleRu: 'Отвечайте за 24 часа',
    titleEn: 'Reply within 24 hours',
    descriptionUz:
      "Hozirgi o'rtacha javob vaqtingiz sutkadan uzoq. Tez javob bergan biznes mijoz uchun jonli va ishonchli ko'rinadi.",
    descriptionRu:
      'Сейчас ваше среднее время ответа больше суток. Быстрый ответ показывает клиенту, что бизнес живой и надёжный.',
    descriptionEn:
      'Your average reply time is currently over a day. Fast replies signal to customers that the business is active and reliable.',
    actionTextUz: 'Javobsiz sharhlar',
    actionTextRu: 'Отзывы без ответа',
    actionTextEn: 'Unanswered reviews',
    impactUz: '+40% reyting',
    impactRu: '+40% к рейтингу',
    impactEn: '+40% rating',
    actionUrl: '/dashboard/reviews?filter=unanswered',
    // Only meaningful once they have actually replied to something — a business
    // that has never replied gets ENGAGEMENT_REPLY_TO_REVIEWS instead, which is
    // the more basic instruction.
    detect: (f) => f.replyCount > 0 && f.avgReplySeconds !== null && f.avgReplySeconds > 24 * 3600,
  },
];
