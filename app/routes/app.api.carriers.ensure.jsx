import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";

// 调试用：强制创建/更新 CarrierService，并返回当前服务列表与会话信息
export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const nameParam = (url.searchParams.get("name") || "").trim();
  const NAME = nameParam || process.env.CARRIER_SERVICE_NAME || "ECOCJ Carrier";
  const origin = process.env.SHOPIFY_APP_URL && process.env.SHOPIFY_APP_URL.trim().length > 0
    ? process.env.SHOPIFY_APP_URL
    : new URL(request.url).origin;
  const callback_url = `${origin}/api/carrier/callback`;

  try {
    const listResp = await admin.rest.get({ path: 'carrier_services.json' });
    const services = listResp?.body?.carrier_services || [];
    const exists = services.find((s) => (s?.name || s?.service_name) === NAME);

    if (!exists) {
      try {
        await admin.rest.post({
          path: 'carrier_services.json',
          data: { carrier_service: { name: NAME, callback_url, service_discovery: true } },
          type: 'application/json',
        });
      } catch (e) {
        // 如果已被配置，Shopify 会返回 422；将其视为已存在并继续
        const msg = e?.message || '';
        const isConfigured = typeof msg === 'string' && msg.includes('already configured');
        if (!isConfigured) {
          // 也可能是 Response 对象，尝试读取状态码
          try {
            if (e?.response?.status !== 422) throw e;
          } catch {
            throw e;
          }
        }
      }
    } else {
      const id = exists.id || exists.admin_graphql_api_id || exists?.carrier_service?.id;
      try {
        await admin.rest.put({
          path: `carrier_services/${id}.json`,
          data: { carrier_service: { name: NAME, callback_url, service_discovery: true } },
          type: 'application/json',
        });
      } catch (e) {
        // ignore update errors; we'll still return current list below
      }
    }

    const afterResp = await admin.rest.get({ path: 'carrier_services.json' });
    const after = afterResp?.body?.carrier_services || [];
    const brief = after.map((s) => ({ id: s.id, name: s.name || s.service_name, callback_url: s.callback_url, service_discovery: s.service_discovery }));

    return json({
      ok: true,
      shop: session?.shop || null,
      scope: session?.scope || null,
      callback_url,
      name_used: NAME,
      services: brief,
      diagnostics: {
        hasRest: !!admin?.rest,
        restKeys: admin?.rest ? Object.keys(admin.rest) : [],
      },
    });
  } catch (e) {
    let errText = e?.message || String(e);
    let status = 500;
    let statusText = undefined;
    try {
      if (e?.response) {
        status = e.response.status || status;
        statusText = e.response.statusText || statusText;
        const bodyText = await e.response.text();
        if (bodyText) errText = bodyText;
      } else if (e instanceof Response) {
        status = e.status || status;
        statusText = e.statusText || statusText;
        const bodyText = await e.text();
        if (bodyText) errText = bodyText;
      }
    } catch {}
    return json({ ok: false, error: errText, status, statusText, shop: session?.shop || null, scope: session?.scope || null, callback_url, name_used: NAME, diagnostics: {
      hasRest: !!admin?.rest,
      restKeys: admin?.rest ? Object.keys(admin.rest) : [],
    } }, { status });
  }
};

export const action = loader;
