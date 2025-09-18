import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

// 诊断页：检查 CarrierService / 回调 URL / 重复服务 / 规则覆盖
export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session?.shop || null;

  // 期望的回调域名（必须是公网 https）
  const origin = process.env.SHOPIFY_APP_URL && process.env.SHOPIFY_APP_URL.trim().length > 0
    ? process.env.SHOPIFY_APP_URL
    : new URL(request.url).origin;
  const httpsOk = typeof origin === "string" && origin.startsWith("https://");
  const callback_url = `${origin}/api/carrier/callback`;

  // 读取 CarrierService 列表（两种方式，合并去重）
  let servicesRaw = [];
  let servicesRes = [];
  let restDiagnostics = { hasRest: !!admin?.rest };
  try {
    const listResp = await admin.rest.get({ path: 'carrier_services.json' });
    servicesRaw = listResp?.body?.carrier_services || [];
  } catch (e) {
    restDiagnostics.rawError = e?.message || String(e);
  }
  try {
    if (admin?.rest?.resources?.CarrierService?.all) {
      const list2 = await admin.rest.resources.CarrierService.all({});
      servicesRes = Array.isArray(list2?.data) ? list2.data : list2?.carrier_services || [];
    } else {
      restDiagnostics.noResourcesApi = true;
    }
  } catch (e) {
    restDiagnostics.resourcesError = e?.message || String(e);
  }
  // 合并
  const normalizeItem = (s) => ({
    id: s.id,
    name: s.name || s.service_name,
    callback_url: s.callback_url,
    service_discovery: s.service_discovery,
  });
  const mergedMap = new Map();
  [...servicesRaw, ...servicesRes].forEach((s) => {
    if (!s) return;
    const id = s.id || s.admin_graphql_api_id || `${s.name}-${s.callback_url}`;
    if (!mergedMap.has(id)) mergedMap.set(id, normalizeItem(s));
  });
  const services = Array.from(mergedMap.values());

  // 重复检测（按 name / service_name 合并）
  const normName = (s) => (s?.name || s?.service_name || '').trim();
  const groups = services.reduce((acc, s) => {
    const key = normName(s);
    if (!acc[key]) acc[key] = [];
    acc[key].push({ id: s.id, name: s.name || s.service_name, callback_url: s.callback_url, service_discovery: s.service_discovery });
    return acc;
  }, {});
  const duplicates = Object.entries(groups)
    .filter(([, arr]) => (arr || []).length > 1)
    .map(([key, arr]) => ({ name: key, count: arr.length, items: arr }));

  // 读取本店铺的规则与覆盖
  let rules = [];
  try {
    if (shop) {
      rules = await prisma.shippingRule.findMany({ where: { shop }, include: { ranges: true } });
    }
  } catch (e) {
    // ignore
  }

  const rulesBrief = rules.map((r) => ({
    id: r.id,
    name: r.name,
    chargeBy: r.chargeBy,
    countriesCount: Array.isArray(r.countries) ? r.countries.length : 0,
    rangesCount: Array.isArray(r.ranges) ? r.ranges.length : 0,
    exampleRange: r.ranges?.[0]
      ? { from: r.ranges[0].fromVal, to: r.ranges[0].toVal, unit: r.ranges[0].unit }
      : null,
  }));

  return json({
    ok: true,
    shop,
    expected_origin: origin,
    https_required: true,
    https_ok: httpsOk,
    expected_callback_url: callback_url,
    services: services.map((s) => ({ id: s.id, name: normName(s), callback_url: s.callback_url, service_discovery: s.service_discovery })),
    duplicates,
    rules_count: rules.length,
    rules_brief: rulesBrief,
    restDiagnostics,
  });
};

// 可选：清理重复服务（危险操作：仅在你确认后调用）
export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const body = await request.json().catch(() => ({}));
  const { cleanupDuplicates = false, name } = body || {};
  if (!cleanupDuplicates) return json({ ok: false, error: 'No action taken' }, { status: 400 });

  const targetName = typeof name === 'string' && name.trim().length ? name.trim() : null;

  const listResp = await admin.rest.get({ path: 'carrier_services.json' });
  const services = listResp?.body?.carrier_services || [];

  // 分组
  const normName = (s) => (s?.name || s?.service_name || '').trim();
  const groups = services.reduce((acc, s) => {
    const key = normName(s);
    if (!acc[key]) acc[key] = [];
    acc[key].push(s);
    return acc;
  }, {});

  const deletions = [];
  for (const [key, arr] of Object.entries(groups)) {
    if ((arr || []).length <= 1) continue;
    if (targetName && key !== targetName) continue;
    // 保留最新（按 id 字符串或 created_at 不一定有），这里保留第一项，删除其余
    const toDelete = arr.slice(1);
    for (const s of toDelete) {
      try {
        await admin.rest.delete({ path: `carrier_services/${s.id}.json` });
        deletions.push({ id: s.id, name: s.name || s.service_name });
      } catch (e) {
        deletions.push({ id: s.id, name: s.name || s.service_name, error: e?.message || String(e) });
      }
    }
  }

  return json({ ok: true, deletions });
};
