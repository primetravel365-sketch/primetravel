// ============================================================
// وسيط (Serverless Proxy) بين موقع PrimeTravel365 وFlightAPI.io — Flight Tracking API
// أُضيف 20 أغسطس 2026 عشان نغني ميزة "تتبع الطيران المباشر" الموجودة أصلًا على الموقع (اللي كانت
// وكانت وهتفضل برضه بتفتح Flightradar24.com فى تبويب جديد للخريطة المباشرة — الميزة دي منغيّرهاش)،
// بإضافة عرض حالة الرحلة الحقيقية (مطار المغادرة/الوصول، المواعيد، البوابة، الصالة) مباشرة جوه
// موقعنا كمان، كميزة تميّز إضافية — مش بديل عن رابط Flightradar24.
//
// مكان الملف في المستودع: api/flightapi-track.js (جوه مجلد api/، بنفس مستوى باقي ملفات api/)
// بيستخدم نفس متغيّر البيئة FLIGHTAPI_KEY المُضاف بالفعل فى Vercel (نفس مفتاح flightapi-search.js).
//
// ⚠️ تنبيه استهلاك: كل نداء بيكلّف 1 كريديت من رصيد FlightAPI.io الشهري (أرخص من نداء الأسعار
// اللي بيكلف 2). الموقع بيستدعي الميزة دي بس لما FLIGHTAPI_REAL_SEARCH_ENABLED = true أو
// ?live_flights=1 فى الرابط — نفس حماية الكريديت المستخدمة مع البحث عن الأسعار بالظبط.
//
// مرجع التوثيق الرسمي (بتاريخ الإنشاء):
//   https://api.flightapi.io/airline/<key>?num=<flight_number>&name=<airline_code>&date=<YYYYMMDD>&depap=<optional_dep_airport>
// شكل الرد: مصفوفة عناصر، كل عنصر إما {departure:{...}} أو {arrival:{...}} — بندمجهم هنا فى
// كائن واحد مبسّط {departure, arrival} أسهل فى الاستخدام من ناحية الموقع.
// ============================================================
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  try {
    if (req.method === 'OPTIONS') { res.status(200).end(); return; }
    if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return; }

    const { num, name, date, depap } = req.query || {};
    if (!num || !name) {
      res.status(400).json({ error: 'num (flight number) and name (airline code) are required' });
      return;
    }

    const key = process.env.FLIGHTAPI_KEY;
    if (!key) {
      res.status(500).json({ error: 'FLIGHTAPI_KEY غير مضاف في إعدادات Vercel (Environment Variables)' });
      return;
    }

    // لو التاريخ مش متبعت، نستخدم تاريخ النهارده (بتوقيت السيرفر) — الميزة دي أصلًا لتتبع رحلة
    // النهارده، مش رحلات مستقبلية بعيدة.
    let dateParam = date;
    if (!dateParam) {
      const now = new Date();
      const y = now.getUTCFullYear();
      const m = String(now.getUTCMonth() + 1).padStart(2, '0');
      const d = String(now.getUTCDate()).padStart(2, '0');
      dateParam = `${y}${m}${d}`;
    }

    let url = `https://api.flightapi.io/airline/${key}?num=${encodeURIComponent(num)}&name=${encodeURIComponent(name)}&date=${encodeURIComponent(dateParam)}`;
    if (depap) url += `&depap=${encodeURIComponent(depap)}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    let apiRes;
    try {
      apiRes = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
    } catch (fetchErr) {
      clearTimeout(timeoutId);
      if (fetchErr && fetchErr.name === 'AbortError') {
        res.status(200).json({ departure: null, arrival: null, note: 'flightapi_timeout' });
      } else {
        res.status(502).json({ error: 'تعذّر الاتصال بـ FlightAPI.io: ' + String(fetchErr) });
      }
      return;
    }
    clearTimeout(timeoutId);

    const contentType = apiRes.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      res.status(200).json({ departure: null, arrival: null, note: 'unexpected_response' });
      return;
    }

    const json = await apiRes.json();
    if (!apiRes.ok) {
      res.status(apiRes.status).json({ error: (json && (json.message || json.error)) || 'FlightAPI.io error' });
      return;
    }

    const arr = Array.isArray(json) ? json : [];
    const depEntry = arr.find(x => x && x.departure) || null;
    const arrEntry = arr.find(x => x && x.arrival) || null;

    const simplify = (o) => {
      if (!o) return null;
      return {
        airport: o.airport || '',
        city: o.airportCity || o.airport || '',
        code: o.airportCode || '',
        scheduledTime: o.scheduledTime || '',
        estimatedTime: o.estimatedTime || '',
        terminal: o.terminal || '',
        gate: o.gate || '',
        dateTime: o.departureDateTime || o.arrivalDateTime || '',
        timeRemaining: o.timeRemaining || '',
      };
    };

    const departure = simplify(depEntry && depEntry.departure);
    const arrival = simplify(arrEntry && arrEntry.arrival);

    if (!departure && !arrival) {
      res.status(200).json({ departure: null, arrival: null, note: 'not_found' });
      return;
    }

    res.status(200).json({ departure, arrival });
  } catch (err) {
    try { res.status(500).json({ error: String(err) }); } catch (_e2) { /* الرد اتبعت بالفعل */ }
  }
};
