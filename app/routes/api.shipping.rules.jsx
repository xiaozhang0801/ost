import { json } from "@remix-run/node";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";

// 与 carrier 回调一致的归一化
function normalizeCountry(input) {
  if (!input && input !== 0) return "";
  const raw = String(input).trim();
  if (!raw) return "";
  const up = raw.toUpperCase();
  const map = {
    CN: "CN", CHN: "CN", CHINA: "CN", 中国: "CN", 中國: "CN",
    US: "US", USA: "US", UNITEDSTATES: "US", "UNITED STATES": "US", 美国: "US", 美國: "US",
    CA: "CA", CAN: "CA", CANADA: "CA", 加拿大: "CA",
    GB: "GB", UK: "GB", GBR: "GB", UNITEDKINGDOM: "GB", "UNITED KINGDOM": "GB", 英国: "GB", 英國: "GB",
    DE: "DE", DEU: "DE", GERMANY: "DE", 德国: "DE", 德國: "DE",
    FR: "FR", FRA: "FR", FRANCE: "FR", 法国: "FR", 法國: "FR",
    AU: "AU", AUS: "AU", AUSTRALIA: "AU", 澳大利亚: "AU", 澳大利亞: "AU",
    JP: "JP", JPN: "JP", JAPAN: "JP", 日本: "JP",
    HK: "HK", HKG: "HK", HONGKONG: "HK", "HONG KONG": "HK", 香港: "HK",
    MO: "MO", MAC: "MO", MACAU: "MO", 澳门: "MO", 澳門: "MO",
    TW: "TW", TWN: "TW", TAIWAN: "TW", 台湾: "TW", 臺灣: "TW",
  };
  const key = up.replace(/\s+/g, "");
  return map[key] || up;
}

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session?.shop;
  if (!shop) return json({ error: "Unauthorized" }, { status: 401 });

  const rules = await prisma.shippingRule.findMany({
    where: { shop },
    include: { ranges: true },
    orderBy: { createdAt: "desc" },
  });
  // 读取时将 countries 统一标准化输出（字符串数组）
  const normalized = rules.map((r) => ({
    ...r,
    countries: Array.isArray(r.countries) ? r.countries.map((c) => normalizeCountry(c)) : [],
  }));
  return json({ rules: normalized });
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session?.shop;
  if (!shop) return json({ error: "Unauthorized" }, { status: 401 });

  const payload = await request.json();
  const {
    name = "",
    chargeBy = "weight",
    countries = [],
    description = null,
    ranges = [],
  } = payload || {};

  if (!name || !Array.isArray(ranges) || ranges.length === 0) {
    return json({ error: "参数不完整" }, { status: 400 });
  }

  // 标准化国家列表：支持字符串或对象格式
  const normalizedCountries = Array.isArray(countries)
    ? countries
        .map((c) => (typeof c === 'string' ? c : (c?.code || c?.value || c?.label || '')))
        .map((c) => normalizeCountry(c))
        .filter(Boolean)
    : [];

  // Create rule with nested ranges
  const rule = await prisma.shippingRule.create({
    data: {
      shop,
      name,
      chargeBy,
      countries: normalizedCountries,
      description,
      ranges: {
        create: ranges.map((r) => ({
          fromVal: Number(r.from ?? r.fromVal ?? 0),
          toVal: Number(r.to ?? r.toVal ?? 0),
          unit: r.unit || (chargeBy === "volume" ? "CBM" : chargeBy === "quantity" ? "件" : "KG"),
          pricePer: Number(r.pricePer ?? 0),
          fee: Number(r.fee ?? 0),
          feeUnit: r.feeUnit || "CNY",
        })),
      },
    },
    include: { ranges: true },
  });

  return json({ rule });
};
