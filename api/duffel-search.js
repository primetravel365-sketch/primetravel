// ============================================================
// وسيط (Serverless Proxy) بين موقع PrimeTravel365 وAPI الحقيقي بتاع Duffel.
// السبب: توكن Duffel لازم يفضل على السيرفر بس، مش داخل كود الموقع (site.html) اللي أي زائر
// يقدر يشوفه بـ"View Page Source" — خصوصًا لما يبقى توكن حقيقي (duffel_live_...) بعد قبول KYC،
// لأنه ساعتها بيقدر يعمل حجوزات حقيقية بفلوس حقيقية لو حد سرقه من الكود.
//
// مكان الملف في المستودع: api/duffel-search.js (في نفس مستوى site.html، داخل مجلد اسمه api)
// Vercel بيتعرف على أي ملف داخل مجلد api/ تلقائيًا كـ Serverless Function بدون أي إعداد إضافي.
//
// التوكن نفسه مش مكتوب هنا خالص — لازم يتحط كـ Environment Variable في لوحة Vercel:
// Project Settings → Environment Variables → اسم المتغيّر: DUFFEL_TOKEN → القيمة: التوكن (test أو live)
// ============================================================
module.exports = async function handler(req, res) {
  // لو حبيت تقفلها على دومين موقعك بس بدل '*', استبدل السطر ده بدومينك الحقيقي
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const { origin, destination, departure_date, return_date } = req.query;
  if (!origin || !destination || !departure_date) {
    res.status(400).json({ error: 'origin, destination, and departure_date are required' });
    return;
  }

  const token = process.env.DUFFEL_TOKEN;
  if (!token) {
    res.status(500).json({ error: 'DUFFEL_TOKEN غير مضاف في إعدادات Vercel (Environment Variables)' });
    return;
  }

  const slices = [{ origin, destination, departure_date }];
  if (return_date) slices.push({ origin: destination, destination: origin, departure_date: return_date });

  try {
    const duffelRes = await fetch('https://api.duffel.com/air/offer_requests?return_offers=true', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Duffel-Version': 'v2',
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({ data: { slices, passengers: [{ type: 'adult' }] } }),
    });
    const json = await duffelRes.json();
    if (!duffelRes.ok) {
      res.status(duffelRes.status).json({ error: (json && json.errors) || 'Duffel API error' });
      return;
    }
    const offers = (json.data && json.data.offers) || [];
    if (!offers.length) { res.status(200).json({ price: null }); return; }
    // أرخص عرض من بين كل العروض الحقيقية الراجعة
    const cheapest = offers.reduce((min, o) =>
      (parseFloat(o.total_amount) < parseFloat(min.total_amount) ? o : min), offers[0]);
    res.status(200).json({
      price: parseFloat(cheapest.total_amount),
      currency: cheapest.total_currency,
      airline: cheapest.owner && cheapest.owner.name,
      live_mode: json.data.live_mode,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
}
