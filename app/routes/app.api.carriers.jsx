import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";

// 调试用：查看当前店铺的 CarrierService 列表与关键字段
export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  try {
    if (!admin?.rest?.resources?.CarrierService) {
      return json({ error: "CarrierService resource not available", diagnostics: { hasRest: !!admin?.rest, hasResources: !!admin?.rest?.resources } }, { status: 500 });
    }
    const listResp = await admin.rest.resources.CarrierService.all({});
    const services = Array.isArray(listResp?.data) ? listResp.data : listResp?.carrier_services || [];
    // 仅输出关键字段，避免泄露过多
    const brief = services.map((s) => ({
      id: s.id,
      name: s.name || s.service_name,
      callback_url: s.callback_url,
      service_discovery: s.service_discovery,
    }));
    return json({ services: brief });
  } catch (e) {
    if (e instanceof Response) {
      try {
        const text = await e.text();
        return json({ error: text || e.statusText || String(e) }, { status: e.status || 500 });
      } catch {
        return json({ error: e.statusText || String(e) }, { status: e.status || 500 });
      }
    }
    return json({ error: e?.message || String(e) }, { status: 500 });
  }
};

export const action = loader;
