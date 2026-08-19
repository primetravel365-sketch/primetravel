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
//
// تحديث 19 أغسطس 2026: طلبات "ذهاب وعودة" (رحلتين/slices) كانت أحيانًا بتاخد وقت طويل جدًا مع
// Duffel في وضع الاختبار وترجع صفحة HTML بدل JSON، وده كان يسبب كراش كامل للدالة (FUNCTION_INVOCATION_FAILED)
// بدل رسالة خطأ نضيفة. الإصلاح: (1) مهلة زمنية قصوى 8 ثواني عبر AbortController بدل الانتظار للأبد،
// (2) التحقق من نوع الرد (Content-Type) قبل محاولة تحليله كـJSON، (3) try/catch يغلّف كل حاجة من الأول.
// ============================================================
module.exports = async function handler(req, res) {
  // لو حبيت تقفلها على دومين موقعك بس بدل '*', استبدل السطر ده بدومينك الحقيقي
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  try {
    if (req.method === 'OPTIONS') { res.status(200).end(); return; }
    if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return; }

    const { origin, destination, departure_date, return_date } = req.query || {};
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

    // مهلة قصوى 8 ثواني (أقل من الحد الافتراضي لوقت تنفيذ الدالة على Vercel Hobby) — لو Duffel
    // اتأخرت أكتر من كده، نقفل الطلب بأنفسنا ونرجع خطأ واضح بدل ما المنصة تكراش الدالة كلها.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    let duffelRes;
    try {
      duffelRes = await fetch('https://api.duffel.com/air/offer_requests?return_offers=true', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Duffel-Version': 'v2',
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({ data: { slices, passengers: [{ type: 'adult' }] } }),
        signal: controller.signal,
      });
    } catch (fetchErr) {
      clearTimeout(timeoutId);
      if (fetchErr && fetchErr.name === 'AbortError') {
        res.status(200).json({ price: null, note: 'duffel_timeout' }); // نرجع price:null بدل خطأ — الموقع هيفضل بالسعر التقديري بهدوء
      } else {
        res.status(502).json({ error: 'تعذّر الاتصال بـ Duffel: ' + String(fetchErr) });
      }
      return;
    }
    clearTimeout(timeoutId);

    // نتحقق من نوع الرد قبل أي محاولة لتحليله كـJSON — لو رجع HTML (صفحة خطأ من أي بوابة وسيطة)،
    // كان ده سبب الكراش الأصلي. دلوقتي بنتعامل معه برسالة نضيفة بدل ما ننفجر.
    const contentType = duffelRes.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      const rawText = await duffelRes.text();
      res.status(200).json({ price: null, note: 'unexpected_response', preview: rawText.slice(0, 200) });
      return;
    }

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
    // شبكة أمان أخيرة: أي خطأ غير متوقع في أي سطر فوق يترجم لرد JSON نضيف بدل كراش خام من المنصة
    try { res.status(500).json({ error: String(err) }); } catch (_e2) { /* الرد اتبعت بالفعل */ }
  }
}
