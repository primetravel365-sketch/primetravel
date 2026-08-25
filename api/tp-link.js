// ============================================================
// وسيط (Serverless Proxy) بين موقع PrimeTravel365 وTravelpayouts Links API.
// الهدف: بناء رابط تتبّع حقيقي (deep link) لـAviasales معبّى فعليًا بالمسار/التاريخ المختار،
// بدل الرابط الثابت الحالي (aviasales.tpm.lv/Sbbqh9Uk) اللي بيوديك لصفحة Aviasales الرئيسية.
// السبب إن ده لازم يبقى عن طريق السيرفر (زي api/tp-price.js بالظبط) مش مباشرة من المتصفح:
// التوكن (TP_TOKEN) سري ولازم يفضل مخفي عن View Page Source.
//
// مكان الملف: api/tp-link.js (جوه مجلد api/، بنفس مستوى tp-price.js وduffel-search.js)
// نفس متغيّر البيئة الموجود بالفعل فى Vercel: TP_TOKEN (لا يحتاج إضافة متغيّر جديد)
//
// مصدر توثيق الـendpoint نفسه (تم التأكد منه 25 أغسطس 2026):
// https://support.travelpayouts.com/hc/en-us/articles/25289759198226-API-for-Travelpayouts-partner-links
//
// ⚠️ ملاحظة مهمة: التوثيق الرسمي ما يوضّحش صراحة اسم الـheader المستخدم لتوكن endpoint ده
// تحديدًا (بعكس v2/prices/latest اللي بياخد token كـquery param). استخدمنا هنا الطريقتين معًا
// (header X-Access-Token + توكن جوه الـbody نفسه مش موجود أصلاً فى شكل الطلب الرسمي) — لو فشل
// أول استدعاء فعلي بـ401/403، جرّب تحويل التوكن لـquery param (?token=) بدل الـheader، أو
// راسل دعم Travelpayouts للتأكيد.
// ============================================================
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  try {
    if (req.method === 'OPTIONS') { res.status(200).end(); return; }
    if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return; }

    const { url, sub_id } = req.query || {};
    if (!url) {
      res.status(400).json({ error: 'url مطلوب (رابط بحث Aviasales كامل غير مختصر)' });
      return;
    }

    const token = process.env.TP_TOKEN;
    if (!token) {
      res.status(500).json({ error: 'TP_TOKEN غير مضاف في إعدادات Vercel (Environment Variables)' });
      return;
    }

    // القيم دي مؤكدة فعليًا من رد دعم Travelpayouts (25 أغسطس 2026):
    // trs = project ID الخاص بـprimetravel365 لبرنامج Aviasales
    // marker = رقم حساب أحمد (759759) — نفس الرقم المستخدم مع Kiwi.com
    const TRS = 563031;
    const MARKER = 759759;

    const body = {
      trs: TRS,
      marker: MARKER,
      shorten: true,
      links: [{ url, ...(sub_id ? { sub_id: String(sub_id) } : {}) }],
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    let tpRes;
    try {
      tpRes = await fetch('https://api.travelpayouts.com/links/v1/create', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-Access-Token': token,
        },
        body: JSON.stringify(body),
      });
    } catch (fetchErr) {
      clearTimeout(timeoutId);
      if (fetchErr && fetchErr.name === 'AbortError') {
        res.status(200).json({ success: false, note: 'tp_link_timeout' });
      } else {
        res.status(502).json({ error: 'تعذّر الاتصال بـTravelpayouts Links API: ' + String(fetchErr) });
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
    const link = json && json.result && Array.isArray(json.result.links) && json.result.links[0];

    if (!tpRes.ok || !link || link.code !== 'success' || !link.partner_url) {
      // فشل حقيقي أو رد غير متوقع — نرجّع success:false عشان الواجهة تستخدم الرابط الثابت كـfallback
      // بدل ما تكسر تجربة المستخدم
      res.status(200).json({ success: false, note: 'tp_link_failed', raw: json });
      return;
    }

    res.status(200).json({ success: true, link: link.partner_url });
  } catch (err) {
    try { res.status(500).json({ error: String(err) }); } catch (_e2) { /* الرد اتبعت بالفعل */ }
  }
};
