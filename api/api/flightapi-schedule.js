// ============================================================
// وسيط (Serverless Proxy) بين موقع PrimeTravel365 وFlightAPI.io — Airport Schedule API v2
// أُضيف 20 أغسطس 2026: ميزة جديدة بالكامل (مش موجودة على الموقع قبل كده) — جدول إقلاع/هبوط
// حقيقي لأي مطار من مطارات الموقع، لتميّز الموقع عن مواقع الميتاسيرش المنافسة اللي عادةً
// مش بتوفر جداول مطارات مباشرة.
//
// مكان الملف في المستودع: api/flightapi-schedule.js (جوه مجلد api/)
// بيستخدم نفس متغيّر البيئة FLIGHTAPI_KEY المُضاف بالفعل فى Vercel.
//
// ⚠️ تنبيه استهلاك: كل نداء بيكلّف 2 كريديت من رصيد FlightAPI.io الشهري (زي نداء الأسعار
// بالظبط). الموقع بيستدعي الميزة دي بس لما FLIGHTAPI_REAL_SEARCH_ENABLED = true أو
// ?live_flights=1 فى الرابط — نفس حماية الكريديت المستخدمة مع باقي ميزات FlightAPI.
//
// مرجع التوثيق الرسمي (بتاريخ الإنشاء):
//   https://api.flightapi.io/schedule/v2/<key>?mode=dep|arr&iata=<AIRPORT_CODE>&year=YYYY&month=MM&day=DD&page=1
// شكل الرد: { data: { header:{...}, flights:[{sortTime, departureTime, arrivalTime, carrier:{fs,name,flightNumber}, airport:{fs,city}}, ...] } }
// ============================================================
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  try {
    if (req.method === 'OPTIONS') { res.status(200).end(); return; }
    if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return; }

    const { iata, mode, year, month, day, page } = req.query || {};
    if (!iata) {
      res.status(400).json({ error: 'iata (airport code) is required' });
      return;
    }

    const key = process.env.FLIGHTAPI_KEY;
    if (!key) {
      res.status(500).json({ error: 'FLIGHTAPI_KEY غير مضاف في إعدادات Vercel (Environment Variables)' });
      return;
    }

    // mode: نقبل 'departures'/'arrivals' أو الاختصار 'dep'/'arr' من الموقع، ونحوّلهم للاختصار
    // اللي فعليًا شغال حسب المثال الرسمي فى التوثيق (mode=dep).
    const modeRaw = (mode || 'dep').toLowerCase();
    const modeParam = modeRaw.startsWith('arr') ? 'arr' : 'dep';

    const now = new Date();
    const y = year || String(now.getUTCFullYear());
    const m = month || String(now.getUTCMonth() + 1).padStart(2, '0');
    const d = day || String(now.getUTCDate()).padStart(2, '0');
    const p = page || '1';

    const url = `https://api.flightapi.io/schedule/v2/${key}?mode=${modeParam}&iata=${encodeURIComponent(iata)}&year=${y}&month=${m}&day=${d}&page=${p}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    let apiRes;
    try {
      apiRes = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
    } catch (fetchErr) {
      clearTimeout(timeoutId);
      if (fetchErr && fetchErr.name === 'AbortError') {
        res.status(200).json({ flights: [], note: 'flightapi_timeout' });
      } else {
        res.status(502).json({ error: 'تعذّر الاتصال بـ FlightAPI.io: ' + String(fetchErr) });
      }
      return;
    }
    clearTimeout(timeoutId);

    const contentType = apiRes.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      res.status(200).json({ flights: [], note: 'unexpected_response' });
      return;
    }

    const json = await apiRes.json();
    if (!apiRes.ok) {
      res.status(apiRes.status).json({ error: (json && (json.message || json.error)) || 'FlightAPI.io error' });
      return;
    }

    const data = (json && json.data) || {};
    const header = data.header || {};
    const rawFlights = Array.isArray(data.flights) ? data.flights : [];

    const flights = rawFlights.map(f => ({
      time: (f.departureTime && f.departureTime.time24) || (f.arrivalTime && f.arrivalTime.time24) || '',
      flightNumber: (f.carrier && ((f.carrier.fs || '') + (f.carrier.flightNumber || ''))) || '',
      airline: (f.carrier && f.carrier.name) || '',
      city: (f.airport && f.airport.city) || '',
      airportCode: (f.airport && f.airport.fs) || '',
    })).filter(f => f.flightNumber);

    res.status(200).json({
      airportTitle: header.title || iata,
      mode: modeParam,
      flights: flights.slice(0, 30),
    });
  } catch (err) {
    try { res.status(500).json({ error: String(err) }); } catch (_e2) { /* الرد اتبعت بالفعل */ }
  }
};
