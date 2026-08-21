// ============================================================
// مهمة مجدولة (Vercel Cron) — تراجع أسعار تنبيهات "🔔" الحقيقية وتبعت إيميل لو السعر نزل
// أُنشئ 20 أغسطس 2026: الجزء الأخير من ميزة تنبيهات انخفاض السعر (بعد جدول Supabase وزرار
// 🔔 نفسه اللي بيسجل التنبيه من المتصفح).
//
// مكان الملف في المستودع: api/check-price-alerts.js
// لازم تُضاف لـvercel.json (أو تُنشأ لو مش موجودة) خانة crons — راجع الشرح المرفق فى نفس الرسالة.
//
// ⚠️ متغيرات بيئة جديدة مطلوبة فى Vercel:
//   - SUPABASE_SERVICE_ROLE_KEY  (من Supabase Dashboard → Project Settings → API → service_role
//     — مفتاح سري بيتخطى RLS، غير الـanon key المستخدم فى الموقع نفسه، محدش غيرنا يشوفه)
//   - RESEND_API_KEY             (من resend.com — باقة مجانية 3000 إيميل/شهر، مفيش بطاقة مطلوبة)
//   - CRON_SECRET                (أي نص عشوائي طويل من اختيارك، عشان محدش يقدر ينادي الرابط ده
//     مباشرة ويستهلك كريديت FlightAPI.io بدون داعي)
//
// ⚠️ حماية استهلاك: نفس فلسفة باقي ميزات FlightAPI.io بالظبط — المهمة دي بتحترم قفل
// FLIGHTAPI_LIVE_ENABLED الموجود بالفعل. لو مقفول (الوضع الافتراضي الحالي)، المهمة بترجع فورًا
// من غير ما تستهلك ولا كريديت واحد — نفس الحماية المطبّقة على البحث والتتبع وجدول المطار.
//
// 🔐 التحقق من CRON_SECRET (أُضيف 21 أغسطس 2026): بندعم طريقتين حتى ما نضطرش نحط السر
// كنص صريح جوه vercel.json (اللي بيتحفظ فى تاريخ الـgit ويفضل موجود للأبد حتى لو اتشال بعدين):
//   1) Header — Vercel نفسه بيبعت "Authorization: Bearer <CRON_SECRET>" تلقائي مع كل استدعاء
//      Cron Job معرّف فى vercel.json طالما متغير CRON_SECRET مضاف فى الإعدادات. الطريقة دي
//      آمنة 100% لأن السر نفسه مش مكتوب فى أي ملف بالمستودع.
//   2) Query param (?secret=...) — للاختبار اليدوي بس (تكتبه بنفسك فى المتصفح وقت الحاجة)،
//      مش موجود فى أي ملف محفوظ فى الريبو.
// ============================================================
module.exports = async function handler(req, res) {
  try {
    const expectedSecret = process.env.CRON_SECRET;
    const authHeader = req.headers && req.headers.authorization;
    const querySecret = req.query && req.query.secret;
    const authorized = !!expectedSecret && (authHeader === `Bearer ${expectedSecret}` || querySecret === expectedSecret);
    if (!authorized) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    if (process.env.FLIGHTAPI_LIVE_ENABLED !== 'true') {
      res.status(200).json({ checked: 0, note: 'temporarily_disabled_same_as_flightapi_kill_switch' });
      return;
    }

    const SUPABASE_URL = 'https://pvspphmdonxvsgicmylp.supabase.co';
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const flightKey = process.env.FLIGHTAPI_KEY;
    const resendKey = process.env.RESEND_API_KEY;
    if (!serviceKey || !flightKey) {
      res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY أو FLIGHTAPI_KEY غير مضافين فى Vercel' });
      return;
    }

    // نجيب أقصى 25 تنبيه نشط لكل تشغيلة — حماية إضافية من استهلاك كريديت كبير دفعة واحدة لو
    // عدد المشتركين كبر. الباقي هيتفحص فى التشغيلة الجاية (المهمة بتشتغل يوميًا).
    const listRes = await fetch(
      `${SUPABASE_URL}/rest/v1/price_alerts?active=eq.true&order=last_checked_at.asc.nullsfirst&limit=25`,
      { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }
    );
    if (!listRes.ok) { res.status(502).json({ error: 'تعذّر قراءة price_alerts من Supabase' }); return; }
    const alerts = await listRes.json();

    let checked = 0, triggered = 0;
    for (const alert of alerts) {
      try {
        const url = `https://api.flightapi.io/onewaytrip/${flightKey}/${alert.origin}/${alert.destination}/${alert.depart_date}/1/0/0/Economy/${(alert.currency || 'AED')}`;
        const r = await fetch(url, { headers: { Accept: 'application/json' } });
        if (!r.ok) continue;
        const data = await r.json();
        const prices = (data.itineraries || []).map(it => it.pricing_options?.[0]?.price?.amount).filter(p => typeof p === 'number');
        const lowest = prices.length ? Math.min(...prices) : null;

        await fetch(`${SUPABASE_URL}/rest/v1/price_alert_checks`, {
          method: 'POST',
          headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ alert_id: alert.id, lowest_price: lowest, source: 'flightapi' }),
        });
        checked++;

        const patch = { last_checked_at: new Date().toISOString(), last_price_seen: lowest };

        if (lowest != null && lowest <= alert.target_price) {
          let emailSent = false;
          if (resendKey && alert.contact_method === 'email') {
            const emailRes = await fetch('https://api.resend.com/emails', {
              method: 'POST',
              headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                from: 'PrimeTravel365 <alerts@primetravel365.com>',
                to: [alert.contact_value],
                subject: `📉 انخفض سعر رحلتك ${alert.origin} → ${alert.destination}`,
                html: `<p>السعر الحالي: <b>${lowest} ${alert.currency}</b> (كنت مستنّي وصوله لـ ${alert.target_price} ${alert.currency} أو أقل)</p><p><a href="https://primetravel365.com/?from=${alert.origin}&to=${alert.destination}&dep=${alert.depart_date}">اضغط هنا للحجز الآن</a></p>`,
              }),
            });
            emailSent = emailRes.ok;
          }
          if (emailSent) {
            patch.active = false;
            patch.triggered_at = new Date().toISOString();
            triggered++;
          }
          // لو الإيميل مبعتش (مفتاح غير مضاف أو خطأ)، التنبيه فاضل active عشان يتحاول تاني المرة الجاية
        }

        await fetch(`${SUPABASE_URL}/rest/v1/price_alerts?id=eq.${alert.id}`, {
          method: 'PATCH',
          headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        });
      } catch (_perAlertErr) { /* فشل تنبيه واحد ما يوقفش الباقي */ }
    }

    res.status(200).json({ checked, triggered, totalActive: alerts.length });
  } catch (err) {
    try { res.status(500).json({ error: String(err) }); } catch (_e2) { /* الرد اتبعت بالفعل */ }
  }
};
