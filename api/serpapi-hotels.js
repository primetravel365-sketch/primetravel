
// ============================================================
// وسيط (Serverless Proxy) بين موقع PrimeTravel365 وSerpApi — Google Hotels API
// أُضيف 20 أغسطس 2026: أول مصدر بيانات فنادق حقيقي للموقع — بيستبدل بيانات genHotels()
// الوهمية بالكامل بأسعار وفنادق حقيقية فعليًا من نتائج Google Hotels.
//
// مكان الملف في المستودع: api/serpapi-hotels.js (جوه مجلد api/، بنفس مستوى باقي ملفات api/)
// يحتاج متغيّر بيئة جديد فى Vercel: SERPAPI_KEY (لسه محتاج تُضاف — راجع خطوات التسجيل).
//
// ⚠️ تنبيه استهلاك: الباقة المجانية من SerpApi 250 عملية بحث شهريًا فقط، وبعدها الباقات
// مدفوعة (تبدأ من حوالي $75/شهر لـ5000 بحث فى وقت كتابة هذا الملف — يُنصح بتأكيد السعر
// الحالي فعليًا من https://serpapi.com/pricing عند التسجيل لأنه قابل للتغيير).
// عشان كده — زي ما اتعلمنا بالظبط من تجربة FlightAPI.io — الحماية هنا مبنية من أول يوم
// على مستوى السيرفر (مش على مستوى الموقع/الـ JS بس)، عشان محدش يقدر يستهلك الرصيد
// بالنداء المباشر على الرابط.
//
// مرجع API: https://serpapi.com/google-hotels-api
//   GET https://serpapi.com/search?engine=google_hotels&q=<city/hotel>&check_in_date=YYYY-MM-DD
//       &check_out_date=YYYY-MM-DD&adults=<n>&currency=<code>&gl=<country>&hl=<lang>&api_key=<key>
// شكل الرد: { properties: [ { name, overall_rating, rate_per_night:{lowest, extracted_lowest},
//             link, reviews, images, hotel_class, ... }, ... ] }
// ============================================================
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  try {
    if (req.method === 'OPTIONS') { res.status(200).end(); return; }
    if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return; }

    // ⚠️ قفل حماية على مستوى السيرفر — نفس فلسفة FLIGHTAPI_LIVE_ENABLED فى flightapi-search.js.
    // القيمة الافتراضية "مقفول" لحد ما تُضاف HOTELS_LIVE_ENABLED=true فى Vercel Environment
    // Variables، عشان محدش يستهلك رصيد SerpApi المجاني/المدفوع أثناء مرحلة الاختبار.
    if (process.env.HOTELS_LIVE_ENABLED !== 'true') {
      res.status(200).json({ properties: [], note: 'temporarily_disabled' });
      return;
    }

    const { q, check_in_date, check_out_date, adults, currency, gl, hl } = req.query || {};
    if (!q || !check_in_date || !check_out_date) {
      res.status(400).json({ error: 'q (city/hotel name), check_in_date, and check_out_date are required' });
      return;
    }

    const key = process.env.SERPAPI_KEY;
    if (!key) {
      res.status(500).json({ error: 'SERPAPI_KEY غير مضاف في إعدادات Vercel (Environment Variables)' });
      return;
    }

    // ============================================================
    // ⚠️ حماية استهلاك تلقائية — أُضيفت 20 أغسطس 2026 بناءً على طلب صريح.
    // الباقة المجانية من SerpApi هي 250 عملية بحث فى الشهر، بتتجدد تلقائيًا كل شهر (مش تجربة
    // 30 يوم بتنتهي زي FlightAPI.io). قبل أي نداء بحث حقيقي، بنسأل SerpApi نفسها (عن طريق
    // account.json — استدعاء مجاني 100%، مش بيخصم من الرصيد إطلاقًا) كام بحث فاضل. لو الرصيد
    // قرّب من الصفر (أقل من أو يساوي SAFETY_BUFFER)، بنوقف البحث الحقيقي فورًا من غير ما نستهلك
    // ولا بحث زيادة، ونرجّع quota_paused — الموقع فى الحالة دي بيرجع تلقائيًا لعرض أسعار تقديرية
    // مع تنويه واضح للمستخدم (بدل ما ندخل مرحلة الدفع المدفوع من غير قصد). ولأن الرصيد بيتجدد
    // شهريًا عند SerpApi نفسها، البحث الحقيقي بيرجع يشتغل تلقائيًا أول ما الشهر الجديد يبدأ —
    // من غير ما نحتاج نتابع تاريخ بأنفسنا أو نعمل أي حاجة يدويًا.
    // كاش بسيط فى الذاكرة (5 دقايق) لتقليل عدد نداءات account.json المتكررة على نفس الـ instance
    // الدافئة — مش ضروري للحماية نفسها (account.json مجاني أصلاً)، بس تحسين بسيط للسرعة.
    const SAFETY_BUFFER = 15;
    if (!global.__serpapiQuotaCache) global.__serpapiQuotaCache = { value: null, ts: 0 };
    const cache = global.__serpapiQuotaCache;
    let quotaLeft = null;
    if (cache.value !== null && (Date.now() - cache.ts) < 5 * 60 * 1000) {
      quotaLeft = cache.value;
    } else {
      try {
        const acctRes = await fetch(`https://serpapi.com/account.json?api_key=${key}`, { headers: { Accept: 'application/json' } });
        if (acctRes.ok) {
          const acctJson = await acctRes.json();
          quotaLeft = (typeof acctJson.plan_searches_left === 'number') ? acctJson.plan_searches_left
                    : (typeof acctJson.total_searches_left === 'number' ? acctJson.total_searches_left : null);
          cache.value = quotaLeft;
          cache.ts = Date.now();
        }
      } catch (_acctErr) { /* فشل التحقق من الرصيد — نتعامل معاه كإيقاف احترازي تحت (quotaLeft يفضل null) */ }
    }
    if (quotaLeft === null || quotaLeft <= SAFETY_BUFFER) {
      res.status(200).json({ properties: [], note: 'quota_paused', searchesLeft: quotaLeft });
      return;
    }
    // ============================================================

    const params = new URLSearchParams({
      engine: 'google_hotels',
      q,
      check_in_date,
      check_out_date,
      adults: adults || '2',
      currency: currency || 'AED',
      gl: gl || 'ae',
      hl: hl || 'en',
      api_key: key,
    });

    const url = `https://serpapi.com/search?${params.toString()}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    let apiRes;
    try {
      apiRes = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
    } catch (fetchErr) {
      clearTimeout(timeoutId);
      if (fetchErr && fetchErr.name === 'AbortError') {
        res.status(200).json({ properties: [], note: 'serpapi_timeout' });
      } else {
        res.status(502).json({ error: 'تعذّر الاتصال بـ SerpApi: ' + String(fetchErr) });
      }
      return;
    }
    clearTimeout(timeoutId);

    const json = await apiRes.json();
    if (!apiRes.ok) {
      res.status(apiRes.status).json({ error: (json && (json.error || json.message)) || 'SerpApi error' });
      return;
    }

    const rawProperties = Array.isArray(json.properties) ? json.properties : [];

    const properties = rawProperties.map(p => ({
      name: p.name || '',
      rating: typeof p.overall_rating === 'number' ? p.overall_rating : null,
      reviews: p.reviews || 0,
      hotelClass: p.hotel_class || '',
      priceFormatted: (p.rate_per_night && p.rate_per_night.lowest) || '',
      priceValue: (p.rate_per_night && p.rate_per_night.extracted_lowest) || null,
      link: p.link || '',
      thumbnail: (Array.isArray(p.images) && p.images[0] && (p.images[0].thumbnail || p.images[0].original_image)) || '',
    })).filter(p => p.name);

    res.status(200).json({
      currency: currency || 'AED',
      properties: properties.slice(0, 20),
    });
  } catch (err) {
    try { res.status(500).json({ error: String(err) }); } catch (_e2) { /* الرد اتبعت بالفعل */ }
  }
};
