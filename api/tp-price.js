// ============================================================
// وسيط (Serverless Proxy) بين موقع PrimeTravel365 وTravelpayouts Data API.
// السبب: توكن Travelpayouts كان لحد دلوقتي مكتوب مباشرة جوه site.html (كود مفتوح لأي زائر
// يشوفه بـ"View Page Source") — ده بيسمح لأي حد ياخده ويستهلك حصة الطلبات بتاعت حسابك أو
// يسيء استخدامه. نفس مبدأ الحماية اللي اتعمل مع Duffel بالظبط (api/duffel-search.js).
//
// مكان الملف: api/tp-price.js (جوه مجلد api/، بنفس مستوى duffel-search.js)
// التوكن نفسه لازم يتحط كـ Environment Variable في Vercel باسم: TP_TOKEN
//
// ============================================================
// 🔴→✅ إصلاح جذري 27 أغسطس 2026 — السبب الحقيقي وراء "مقارنة أسعار الحجز مش ظاهرة":
// بالرجوع للتوثيق الرسمي لـ Travelpayouts (travelpayouts.github.io/slate)، اكتشفنا حاجتين:
//
// 1) mode=latest كان بيبعت باراميتر depart_date غلط تمامًا — الـendpoint ده (v2/prices/latest)
//    أصلًا مالوش باراميتر اسمه depart_date خالص! المطلوب فعليًا period_type=month +
//    beginning_of_period=YYYY-MM-01. كنا بنبعت باراميتر الـAPI مش بيعرفه، فكان بيتجاهله ويرجع
//    نتائج فاضية/غير متوقعة بغض النظر عن أي حاجة تانية.
//
// 2) الأهم: كل الـendpoints دي (latest, week-matrix, month-matrix) عندها باراميتر
//    show_to_affiliates وقيمته الافتراضية true — ومعناها إنها بترجع بس الأسعار اللي "لوحظت"
//    من زوار جم عن طريق رابط الأفلييت (marker) بتاعك انت تحديدًا. لموقع لسه صغير/جديد زي بتاعنا،
//    ده معناه عمليًا صفر بيانات تقريبًا! الحل: show_to_affiliates=false، وده بيوسّع النتيجة
//    لكل الأسعار المخزّنة (cached) عند Travelpayouts من أي زائر، مش بس زوارنا احنا.
//
// وبالتالي: week-matrix (مش latest) هو فعليًا الـendpoint الصحيح لشريط "قارن أسعار أيام الحجز" —
// توثيقه الرسمي بالحرف: "Returns airfare prices for a 7-day period around the specified
// departure date" — يعني ده بالظبط المطلوب (سعر حقيقي لكل يوم من كام يوم قريب من تاريخ معيّن)،
// مش latest. رجّعنا buildCompareStrip() في site.html لاستخدام week-matrix تاني بعد الإصلاح ده.
//
// mode=latest لسه مستخدم في مكان تاني (صف Kiwi.com/Aviasales في شاشة "خيارات الأسعار") فأصلحناه
// بنفس المبدأ (period_type/beginning_of_period بدل depart_date) بدل ما نشيله.
// ============================================================
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  try {
    if (req.method === 'OPTIONS') { res.status(200).end(); return; }
    if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return; }

    const { mode, origin, destination, depart_date, return_date, currency } = req.query || {};
    if (!origin || !destination) {
      res.status(400).json({ error: 'origin and destination are required' });
      return;
    }

    const token = process.env.TP_TOKEN;
    if (!token) {
      res.status(500).json({ error: 'TP_TOKEN غير مضاف في إعدادات Vercel (Environment Variables)' });
      return;
    }

    const cur = (currency || 'usd').toLowerCase();
    let url;
    if (mode === 'week-matrix') {
      // ✅ الإصلاح: show_to_affiliates=false عشان نشوف كل الأسعار المخزّنة عند Travelpayouts،
      // مش بس اللي جت من زوار موقعنا بالتحديد (اللي عمليًا صفر لحد دلوقتي).
      const params = new URLSearchParams({ origin, destination, currency: cur, token, show_to_affiliates: 'false' });
      if (depart_date) params.set('depart_date', depart_date);
      if (return_date) params.set('return_date', return_date);
      url = 'https://api.travelpayouts.com/v2/prices/week-matrix?' + params.toString();
    } else {
      // ✅ الإصلاح: mode=latest (افتراضي) — الـendpoint ده معندوش depart_date أصلًا، المطلوب
      // period_type=month + beginning_of_period=YYYY-MM-01 (أول يوم في الشهر المطلوب).
      const monthStr = (depart_date || '').slice(0, 7); // YYYY-MM
      const beginningOfPeriod = monthStr ? monthStr + '-01' : '';
      const params = new URLSearchParams({
        origin, destination, currency: cur, token,
        period_type: 'month',
        show_to_affiliates: 'false',
      });
      if (beginningOfPeriod) params.set('beginning_of_period', beginningOfPeriod);
      url = 'https://api.travelpayouts.com/v2/prices/latest?' + params.toString();
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    let tpRes;
    try {
      tpRes = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
    } catch (fetchErr) {
      clearTimeout(timeoutId);
      if (fetchErr && fetchErr.name === 'AbortError') {
        res.status(200).json({ success: false, note: 'tp_timeout' });
      } else {
        res.status(502).json({ error: 'تعذّر الاتصال بـ Travelpayouts: ' + String(fetchErr) });
      }
      return;
    }
    clearTimeout(timeoutId);

    const contentType = tpRes.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      res.status(200).json({ success: false, note: 'unexpected_response' });
      return;
    }

    const json = await tpRes.json();
    res.status(200).json(json);
  } catch (err) {
    try { res.status(500).json({ error: String(err) }); } catch (_e2) { /* الرد اتبعت بالفعل */ }
  }
};
