// ============================================================
// وسيط (Serverless Proxy) بين موقع PrimeTravel365 وFlightAPI.io — مصدر بيانات طيران حقيقي
// إضافي/بديل عن Duffel (اللي لسه عالق في وضع Test Mode بسبب حظر الإمارات في Duffel Payments).
// بنفس مبدأ الحماية المتبع مع api/duffel-search.js وapi/tp-price.js بالظبط: المفتاح لازم
// يفضل على السيرفر بس، مش داخل كود الموقع اللي أي زائر يقدر يشوفه بـ"View Page Source".
//
// مكان الملف في المستودع: api/flightapi-search.js (جوه مجلد api/، بنفس مستوى الملفين التانيين)
// المفتاح لازم يتحط كـ Environment Variable في Vercel باسم: FLIGHTAPI_KEY
// (اتحط بالفعل بتاريخ 20 أغسطس 2026 — راجع Project Settings → Environment Variables)
//
// ⚠️ تنبيه استهلاك: باقة التجربة المجانية فيها 30 كريديت بس (كل بحث = 2 كريديت = 15 بحث تجريبي
// إجمالي)، وهي تجربة لمرة واحدة (صالحة 30 يوم من التفعيل) مش رصيد شهري متجدد زي SerpApi —
// راجع claude/flightapi-io-research-2026-08-19.md للتفاصيل الكاملة قبل أي قرار ترقية.
//
// مرجع التوثيق الرسمي (بتاريخ الإنشاء):
//   One-way: https://api.flightapi.io/onewaytrip/<key>/<from>/<to>/<date>/<adults>/<children>/<infants>/<cabin>/<currency>
//   Round-trip: https://api.flightapi.io/roundtrip/<key>/<from>/<to>/<depart>/<return>/<adults>/<children>/<infants>/<cabin>/<currency>
// شكل الرد: { itineraries:[...], legs:[...], segments:[...], carriers:[...], places:[...], agents:[...] }
// (شبيه بشكل رد Skyscanner القديم) — الأسماء الحقيقية لشركات الطيران والمطارات بتتجاب عن طريق
// جداول بحث (lookup) منفصلة (carriers/places) بالـid، مش مكتوبة مباشرة جوه كل segment.
// ============================================================
//
// فلترة الشركات الموثوقة — أُضيفت 20 أغسطس 2026 بناءً على طلب المستخدم: بدل ما المسافر
// يشوف 10 أسماء أو أكتر بأسعار متفرقة (زي ما بيحصل فى نتائج API الخام اللي بترجع كل شركة
// طيران موجودة حتى لو غير معروفة/غير موثوقة السعر عندها)، بنعرض بس شركات معروفة وموثوقة،
// وبحد أقصى 8 نتائج (الأرخص أولًا) — بالظبط زي شكل مواقع الميتاسيرش الكبيرة (Wego/Skyscanner).
//
// القايمة دي قابلة للتعديل بسهولة فى أي وقت — تقدر تضيف أو تشيل شركة براحتك.
// المطابقة بتتم بمقارنة جزء من الاسم (lowercase) مش تطابق حرفي كامل، عشان تغطي فروقات
// زي "Etihad" و"Etihad Airways" فى نفس الوقت.
const TRUSTED_AIRLINE_KEYWORDS = [
  // شركات الخليج والشرق الأوسط الأساسية
  'emirates', 'etihad', 'qatar airways', 'turkish airlines', 'egyptair', 'saudia',
  'gulf air', 'oman air', 'kuwait airways', 'jazeera', 'air arabia', 'flydubai',
  'flynas', 'flyadeal', 'royal jordanian', 'wizz air', 'ajet', 'pegasus',
  // شركات دولية كبرى (أوروبا/أمريكا/آسيا)
  'british airways', 'lufthansa', 'air france', 'klm', 'swiss', 'austrian airlines',
  'iberia', 'ita airways', 'finnair', 'sas', 'virgin atlantic', 'singapore airlines',
  'cathay pacific', 'american airlines', 'united airlines', 'delta', 'air canada',
  'qantas', 'air india', 'indigo', 'vistara', 'srilankan', 'pakistan international',
  'philippine airlines', 'malaysia airlines', 'thai airways', 'china southern',
  'china eastern', 'air china', 'japan airlines', 'all nippon', 'korean air', 'asiana',
  'royal air maroc', 'ethiopian airlines', 'kenya airways', 'south african airways',
  'azerbaijan airlines', 'uzbekistan airways', 'air astana',
];
function isTrustedAirline(name) {
  const n = (name || '').toLowerCase();
  return TRUSTED_AIRLINE_KEYWORDS.some(k => n.includes(k));
}

// ============================================================
// ⚠️ كاش نتائج البحث — أُضيف 21 أغسطس 2026 بناءً على طلب صريح من أحمد لتقليل استهلاك
// كريديت FlightAPI.io المحدود (سواء الـ30 كريديت الحاليين، أو الـ30,000 الشهرية لو اشتركنا
// لاحقًا). أسعار الطيران عمليًا مش بتتغير كل دقيقة، فمفيش داعي نستهلك كريديت جديد لو حد
// بحث عن نفس المسار (نفس origin/destination/date/cabin/currency) خلال آخر 35 دقيقة —
// بنرجّع نفس النتيجة المحفوظة بدل ما ننادي FlightAPI.io تاني.
//
// محفوظ فى جدول Supabase منفصل (flightapi_search_cache) بدل الذاكرة المؤقتة للسيرفر
// (زي كاش SerpApi)، لأن دوال Vercel بتترستارت باستمرار والذاكرة المؤقتة مش موثوقة كفاية
// لهدف "توفير كريديت حقيقي" — الجدول محمي بالكامل (RLS من غير أي policy لـanon)، والوصول
// بس عن طريق SUPABASE_SERVICE_ROLE_KEY من السيرفر.
//
// ⚠️ لو SUPABASE_SERVICE_ROLE_KEY لسه مش مضاف فى Vercel، الكاش بيتخطى نفسه تلقائيًا (fail-open)
// والموقع بيكمل يشتغل بنفس السلوك الحالي (نداء حقيقي فى كل مرة) من غير أي كسر — أول ما
// المفتاح يتضاف، الكاش بيشتغل تلقائيًا من غير أي تعديل تاني فى الكود.
const CACHE_TTL_MINUTES = 35;
const SUPABASE_URL = 'https://pvspphmdonxvsgicmylp.supabase.co';

function buildCacheKey(origin, destination, departure_date, return_date, cabin, currency) {
  return [origin, destination, departure_date, return_date || '', cabin, currency].join('|').toLowerCase();
}

async function readCache(cacheKey, serviceKey) {
  if (!serviceKey) return null;
  try {
    const cutoff = new Date(Date.now() - CACHE_TTL_MINUTES * 60000).toISOString();
    const url = `${SUPABASE_URL}/rest/v1/flightapi_search_cache?cache_key=eq.${encodeURIComponent(cacheKey)}&created_at=gte.${encodeURIComponent(cutoff)}&select=response&limit=1`;
    const r = await fetch(url, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } });
    if (!r.ok) return null;
    const rows = await r.json();
    return (Array.isArray(rows) && rows[0] && rows[0].response) || null;
  } catch (_cacheReadErr) { return null; } // أي فشل فى الكاش — نكمل عادي بنداء حقيقي، مش نوقف الموقع
}

async function writeCache(cacheKey, responseObj, serviceKey) {
  if (!serviceKey) return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/flightapi_search_cache`, {
      method: 'POST',
      headers: {
        apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates', // upsert: لو نفس cache_key موجود، يحدّثه بدل ما يفشل
      },
      body: JSON.stringify({ cache_key: cacheKey, response: responseObj, created_at: new Date().toISOString() }),
    });
  } catch (_cacheWriteErr) { /* فشل الكتابة فى الكاش مش لازم يوقف الرد اللي إحنا أصلًا رجّعناه */ }
}
// ============================================================

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  try {
    if (req.method === 'OPTIONS') { res.status(200).end(); return; }
    if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return; }

    // ⚠️ قفل حماية على مستوى السيرفر — أُضيف 20 أغسطس 2026. مهم جدًا: علم FLIGHTAPI_REAL_SEARCH_ENABLED
    // فى site.html بيوقف موقعنا من إنه هو نفسه ينادي الرابط ده، لكن الرابط ده لسه رابط عام (public URL)
    // — أي حد يعرفه أو يشوفه فى كود الصفحة (View Source) يقدر ينادي عليه مباشرة من غير ما يمر
    // بالموقع خالص ويستهلك كريديت. القفل ده هو الحماية الحقيقية اللي بتوقف الاستهلاك فعليًا مهما كان
    // مصدر الطلب. القيمة الافتراضية "مقفول" (لو المتغيّر مش موجود أصلًا فى Vercel). لما تكون جاهز
    // فعليًا (اختبار أو انطلاق)، ضيف Environment Variable جديد فى Vercel اسمه FLIGHTAPI_LIVE_ENABLED
    // بقيمة true (Production + Preview) — بنفس خطوات إضافة FLIGHTAPI_KEY بالظبط.
    if (process.env.FLIGHTAPI_LIVE_ENABLED !== 'true') {
      res.status(200).json({ price: null, note: 'temporarily_disabled' });
      return;
    }

    const {
      origin, destination, departure_date, return_date,
      adults, children, infants, cabin_class, currency,
    } = req.query || {};

    if (!origin || !destination || !departure_date) {
      res.status(400).json({ error: 'origin, destination, and departure_date are required' });
      return;
    }

    const key = process.env.FLIGHTAPI_KEY;
    if (!key) {
      res.status(500).json({ error: 'FLIGHTAPI_KEY غير مضاف في إعدادات Vercel (Environment Variables)' });
      return;
    }

    const a = adults || '1';
    const c = children || '0';
    const inf = infants || '0';
    const cabin = cabin_class || 'Economy';
    const cur = (currency || 'USD').toUpperCase();

    // ⚠️ فحص الكاش الأول — قبل أي نداء حقيقي لـFlightAPI.io. المفتاح مبني على نفس البارامترات
    // المؤثرة على السعر (المسار + التاريخ + الدرجة + العملة) — البالغين/الأطفال/الرضع مش داخلين
    // فى المفتاح حاليًا لأن الموقع بيعرض سعر البالغ الواحد أساسًا؛ لو ده اتغيّر مستقبلًا لازم
    // نضيفهم للمفتاح كمان.
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const cacheKey = buildCacheKey(origin, destination, departure_date, return_date, cabin, cur);
    const cached = await readCache(cacheKey, serviceKey);
    if (cached) {
      res.status(200).json(cached);
      return;
    }

    let url;
    if (return_date) {
      url = `https://api.flightapi.io/roundtrip/${key}/${origin}/${destination}/${departure_date}/${return_date}/${a}/${c}/${inf}/${cabin}/${cur}`;
    } else {
      url = `https://api.flightapi.io/onewaytrip/${key}/${origin}/${destination}/${departure_date}/${a}/${c}/${inf}/${cabin}/${cur}`;
    }

    // مهلة قصوى 8 ثواني — نفس المبدأ المتبع في api/duffel-search.js وapi/tp-price.js، عشان
    // منسيبش الدالة تستنى للأبد لو FlightAPI اتأخرت أو مفيش رد.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    let apiRes;
    try {
      apiRes = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
    } catch (fetchErr) {
      clearTimeout(timeoutId);
      if (fetchErr && fetchErr.name === 'AbortError') {
        res.status(200).json({ price: null, note: 'flightapi_timeout' });
      } else {
        res.status(502).json({ error: 'تعذّر الاتصال بـ FlightAPI.io: ' + String(fetchErr) });
      }
      return;
    }
    clearTimeout(timeoutId);

    const contentType = apiRes.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      const rawText = await apiRes.text();
      res.status(200).json({ price: null, note: 'unexpected_response', preview: rawText.slice(0, 200) });
      return;
    }

    const json = await apiRes.json();
    if (!apiRes.ok) {
      res.status(apiRes.status).json({ error: (json && (json.message || json.error)) || 'FlightAPI.io error' });
      return;
    }

    const itineraries = Array.isArray(json.itineraries) ? json.itineraries : [];
    if (!itineraries.length) { res.status(200).json({ price: null, note: 'no_itineraries' }); return; }

    // جداول بحث (lookup) بالـid لتحويل marketing_carrier_id/place_id لأسماء حقيقية —
    // لو مش موجودة أصلاً في الرد (زي ما نبّه التوثيق إن أحيانًا محتاج أكتر من نداء واحد
    // للبيانات الكاملة)، بنرجع بالـid نفسه كنص بدل ما نكسر الاستجابة.
    const carriersMap = {};
    (Array.isArray(json.carriers) ? json.carriers : []).forEach(c => { carriersMap[c.id] = c.name || c.id; });
    // اتأكد من شكل بيانات places الحقيقي باختبار مباشر: كود المطار/المدينة موجود جوه
    // حقل "display_code" (مش iata_code زي ما كان متوقع افتراضيًا)، مثال حقيقي:
    // { id:13445, name:"Larnaca", type:"Airport", display_code:"LCA" }
    const placesMap = {};
    (Array.isArray(json.places) ? json.places : []).forEach(p => { placesMap[p.id] = { name: p.name || p.id, city: (p.city_name || p.name || p.id), code: p.display_code || null }; });
    const legsMap = {};
    (Array.isArray(json.legs) ? json.legs : []).forEach(l => { legsMap[l.id] = l; });
    const segmentsMap = {};
    (Array.isArray(json.segments) ? json.segments : []).forEach(s => { segmentsMap[s.id] = s; });

    const mapSegment = (seg, fallbackOriginCode, fallbackDestCode) => {
      const carrierName = carriersMap[seg.marketing_carrier_id] || '';
      const originInfo = placesMap[seg.origin_place_id] || null;
      const destInfo = placesMap[seg.destination_place_id] || null;
      // كود المطار الحقيقي لكل segment لازم ييجي من placesMap نفسه (display_code)، مش من
      // كود الرحلة الكامل (origin/destination الأصليين اللي جايين من الطلب) — لأن ده كان بيدي
      // كود غلط لأي محطة توقف وسطية (مثلاً كان بيوريها DXB/CAI حتى لو المحطة عمّان فعليًا).
      const originCode = (originInfo && originInfo.code) || fallbackOriginCode;
      const destCode = (destInfo && destInfo.code) || fallbackDestCode;
      return {
        airline: carrierName,
        flightNumber: (seg.marketing_flight_number != null) ? String(seg.marketing_flight_number) : '',
        aircraft: '',
        departingAt: seg.departure,
        arrivingAt: seg.arrival,
        origin: { code: originCode, name: (originInfo && originInfo.name) || originCode, city: (originInfo && originInfo.city) || originCode },
        destination: { code: destCode, name: (destInfo && destInfo.name) || destCode, city: (destInfo && destInfo.city) || destCode },
      };
    };

    // كل itinerary بيشاور على leg واحد أو أكتر (leg_ids) — كل leg بيشاور على segment واحد أو أكتر
    // (segment_ids) لو فيه توقفات. رحلة الذهاب فقط (one-way) بتديها leg واحد؛ ذهاب وعودة بتديها
    // leg-ين، بالظبط زي قيود Duffel نفسها (باقة سعر واحدة غير قابلة للفصل والدمج الحر) —
    // فالموقع لازم يفضل يتعامل مع نتيجة ذهاب وعودة كباقة واحدة، مش يفصلها زي الاختيار اليدوي الحالي.
    const flights = itineraries.map((it, i) => {
      const price = (it.cheapest_price && it.cheapest_price.amount)
        || (it.pricing_options && it.pricing_options[0] && it.pricing_options[0].price && it.pricing_options[0].price.amount);
      if (price == null) return null;

      const legIds = Array.isArray(it.leg_ids) ? it.leg_ids : (it.leg_id ? [it.leg_id] : []);
      const legsResolved = legIds.map(id => legsMap[id]).filter(Boolean);
      // بديل احتياطي: بعض الردود بترجع leg واحد جوه itinerary نفسه بدل leg_ids
      const legsFinal = legsResolved.length ? legsResolved : (it.legs || []);

      const segments = [];
      legsFinal.forEach(leg => {
        const segIds = Array.isArray(leg.segment_ids) ? leg.segment_ids : [];
        const legSegs = segIds.map(id => segmentsMap[id]).filter(Boolean);
        const legSegsFinal = legSegs.length ? legSegs : [leg]; // لو مفيش segments منفصلة، الـleg نفسه بيغطي رحلة مباشرة
        legSegsFinal.forEach(seg => segments.push(mapSegment(seg, origin, destination)));
      });
      if (!segments.length) return null;

      return {
        offerId: 'flightapi-' + (it.id || i),
        price: parseFloat(price),
        currency: cur,
        airline: segments[0].airline,
        segments,
      };
    }).filter(Boolean).sort((a, b) => a.price - b.price);

    if (!flights.length) { res.status(200).json({ price: null, note: 'no_priced_itineraries' }); return; }

    // فلترة الشركات الموثوقة: بنستبعد أي رحلة (itinerary) لو أي جزء فيها (segment واحد ولو
    // فى رحلة فيها توقف) شركته مش موجودة فى القايمة الموثوقة فوق. لو الفلترة قضت على كل
    // النتائج (مثلاً مسار نادر مفيهوش غير شركات إقليمية صغيرة)، بنرجع للقايمة الأصلية كاملة
    // بدل ما نرجع نتيجة فاضية للمسافر — الأفضلية للفلترة، لكن مش على حساب ظهور نتيجة أصلًا.
    const trustedFlights = flights.filter(f => f.segments.every(seg => isTrustedAirline(seg.airline)));
    // إصلاح 24 أغسطس 2026: كان الحد الأقصى 8 نتائج بس — ده كان بيخفي رحلات حقيقية موجودة فعلاً
    // (مثلاً لو رحلات اتحاد كتير أرخصها برا أول 8 نتيجة إجمالية)، فالزائر لما يفلتر بشركة معينة
    // كان بيشوف رحلة أو اتنين بس رغم وجود رحلات حقيقية أكتر فى الرد الأصلي. رفعناه لـ25 (كل
    // النتائج الموثوقة اللي رجعت فعليًا من FlightAPI تقريبًا)، عشان الفلترة بالشركة تعكس
    // الواقع الفعلي مش نسخة مبتورة منه. التكلفة بالكريديت واحدة (نداء واحد بيرجع كل النتائج
    // دفعة واحدة بغض النظر عن عدد النتائج اللي بنعرضها منه).
    const finalFlights = (trustedFlights.length > 0 ? trustedFlights : flights).slice(0, 25);

    const responseBody = {
      price: finalFlights[0].price,
      currency: cur,
      airline: finalFlights[0].airline,
      flights: finalFlights,
    };

    res.status(200).json(responseBody);
    // بنكتب فى الكاش بعد الرد عشان منأخرش الاستجابة للزائر — فشل الكتابة (لو حصل) مش بيأثر
    // على الرد اللي اتبعت أصلًا.
    writeCache(cacheKey, responseBody, serviceKey);
  } catch (err) {
    try { res.status(500).json({ error: String(err) }); } catch (_e2) { /* الرد اتبعت بالفعل */ }
  }
};
