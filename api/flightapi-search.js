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
// إجمالي). اختبر بعدد قليل من عمليات البحث الأول قبل ما تعتمد عليه بشكل موسّع على الموقع الحي.
//
// مرجع التوثيق الرسمي (بتاريخ الإنشاء):
//   One-way: https://api.flightapi.io/onewaytrip/<key>/<from>/<to>/<date>/<adults>/<children>/<infants>/<cabin>/<currency>
//   Round-trip: https://api.flightapi.io/roundtrip/<key>/<from>/<to>/<depart>/<return>/<adults>/<children>/<infants>/<cabin>/<currency>
// شكل الرد: { itineraries:[...], legs:[...], segments:[...], carriers:[...], places:[...], agents:[...] }
// (شبيه بشكل رد Skyscanner القديم) — الأسماء الحقيقية لشركات الطيران والمطارات بتتجاب عن طريق
// جداول بحث (lookup) منفصلة (carriers/places) بالـid، مش مكتوبة مباشرة جوه كل segment.
// ============================================================
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  try {
    if (req.method === 'OPTIONS') { res.status(200).end(); return; }
    if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return; }

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

    // وضع تشخيص مؤقت (debug=raw) — بيرجع عينة من شكل الرد الخام زي ما هو، عشان نتأكد من
    // أسماء الحقول الفعلية (زي كود الآياتا جوه places) قبل ما نعتمد على التخمين. هيتشال
    // بعد التأكد، مش هيفضل فى النسخة النهائية.
    if (req.query && req.query.debug === 'raw') {
      res.status(200).json({
        placesSample: (Array.isArray(json.places) ? json.places : []).slice(0, 5),
        legsSample: (Array.isArray(json.legs) ? json.legs : []).slice(0, 3),
        segmentsSample: (Array.isArray(json.segments) ? json.segments : []).slice(0, 3),
      });
      return;
    }

    const itineraries = Array.isArray(json.itineraries) ? json.itineraries : [];
    if (!itineraries.length) { res.status(200).json({ price: null, note: 'no_itineraries' }); return; }

    // جداول بحث (lookup) بالـid لتحويل marketing_carrier_id/place_id لأسماء حقيقية —
    // لو مش موجودة أصلاً في الرد (زي ما نبّه التوثيق إن أحيانًا محتاج أكتر من نداء واحد
    // للبيانات الكاملة)، بنرجع بالـid نفسه كنص بدل ما نكسر الاستجابة.
    const carriersMap = {};
    (Array.isArray(json.carriers) ? json.carriers : []).forEach(c => { carriersMap[c.id] = c.name || c.id; });
    const placesMap = {};
    (Array.isArray(json.places) ? json.places : []).forEach(p => { placesMap[p.id] = { name: p.name || p.id, city: (p.city_name || p.name || p.id) }; });
    const legsMap = {};
    (Array.isArray(json.legs) ? json.legs : []).forEach(l => { legsMap[l.id] = l; });
    const segmentsMap = {};
    (Array.isArray(json.segments) ? json.segments : []).forEach(s => { segmentsMap[s.id] = s; });

    const mapSegment = (seg, fallbackOriginCode, fallbackDestCode) => {
      const carrierName = carriersMap[seg.marketing_carrier_id] || '';
      const originInfo = placesMap[seg.origin_place_id] || null;
      const destInfo = placesMap[seg.destination_place_id] || null;
      return {
        airline: carrierName,
        flightNumber: (seg.marketing_flight_number != null) ? String(seg.marketing_flight_number) : '',
        aircraft: '',
        departingAt: seg.departure,
        arrivingAt: seg.arrival,
        origin: { code: fallbackOriginCode, name: (originInfo && originInfo.name) || fallbackOriginCode, city: (originInfo && originInfo.city) || fallbackOriginCode },
        destination: { code: fallbackDestCode, name: (destInfo && destInfo.name) || fallbackDestCode, city: (destInfo && destInfo.city) || fallbackDestCode },
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

    res.status(200).json({
      price: flights[0].price,
      currency: cur,
      airline: flights[0].airline,
      flights: flights.slice(0, 15),
    });
  } catch (err) {
    try { res.status(500).json({ error: String(err) }); } catch (_e2) { /* الرد اتبعت بالفعل */ }
  }
};
