

// ============================================================
// وسيط (Serverless Proxy) بين موقع PrimeTravel365 وTravelpayouts Data API.
// السبب: توكن Travelpayouts كان لحد دلوقتي مكتوب مباشرة جوه site.html (كود مفتوح لأي زائر
// يشوفه بـ"View Page Source") — ده بيسمح لأي حد ياخده ويستهلك حصة الطلبات بتاعت حسابك أو
// يسيء استخدامه. نفس مبدأ الحماية اللي اتعمل مع Duffel بالظبط (api/duffel-search.js).
//
// مكان الملف: api/tp-price.js (جوه مجلد api/، بنفس مستوى duffel-search.js)
// التوكن نفسه لازم يتحط كـ Environment Variable في Vercel باسم: TP_TOKEN
//
// وضعين (mode):
//  - mode=latest        → أرخص سعر معروف عن شهر معين لمسار معين (يُستخدم لصف Kiwi.com/Aviasales
//                          في شاشة "خيارات الأسعار")
//  - mode=week-matrix    → أسعار حقيقية مسجّلة (cached) لأيام قريبة من تاريخ مستهدف، تُستخدم في
//                          شريط "قارن أسعار أيام الحجز" بدل الأرقام المفبركة يدويًا سابقًا
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
      const params = new URLSearchParams({ origin, destination, currency: cur, token });
      if (depart_date) params.set('depart_date', depart_date);
      if (return_date) params.set('return_date', return_date);
      url = 'https://api.travelpayouts.com/v2/prices/week-matrix?' + params.toString();
    } else {
      // mode=latest (افتراضي): depart_date هنا لازم يبقى شهر (YYYY-MM)
      const month = (depart_date || '').slice(0, 7);
      const params = new URLSearchParams({ origin, destination, depart_date: month, currency: cur, token });
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
