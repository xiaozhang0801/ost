import crypto from "crypto";
import { json } from "@remix-run/node";
import prisma from "../db.server";

// 归一化国家输入为 ISO2 代码（尽可能），否则退化为大写修剪后的字符串
function normalizeCountry(input) {
  if (!input && input !== 0) return "";
  const raw = String(input).trim();
  if (!raw) return "";
  const up = raw.toUpperCase();
  // 常见写法到 ISO2 的映射
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
  return map[key] || up; // 未命中时用大写值回退
}

// Verify Shopify HMAC from raw body
function verifyHmac(rawBody, hmac) {
  const secret = process.env.SHOPIFY_API_SECRET || "";
  if (!hmac) return false;
  const digest = crypto
    .createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest("base64");
  const a = Buffer.from(digest);
  const b = Buffer.from(hmac);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export const action = async ({ request }) => {
  const hmac = request.headers.get("x-shopify-hmac-sha256") || request.headers.get("X-Shopify-Hmac-Sha256");
  const shop = request.headers.get("x-shopify-shop-domain") || request.headers.get("X-Shopify-Shop-Domain");

  const rawBody = await request.text();
  const skipHmac = String(process.env.DEV_SKIP_HMAC || "").toLowerCase() === "true";
  if (!skipHmac && !verifyHmac(rawBody, hmac)) {
    return json({ error: "HMAC validation failed" }, { status: 401 });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody || "{}");
  } catch (e) {
    return json({ error: "Invalid JSON" }, { status: 400 });
  }

  // payload example fields: rate (items with grams), destination (country), currency, etc.
  const destinationCountry = payload?.rate?.destination?.country || payload?.rate?.destination?.country_code;
  const currency = payload?.rate?.currency || "CNY";

  // Aggregate weight (kg), quantity (pcs)
  const items = Array.isArray(payload?.rate?.items) ? payload.rate.items : [];
  const totalGrams = items.reduce((acc, it) => acc + (Number(it?.grams || 0)), 0);
  const totalKg = totalGrams / 1000;
  const totalQty = items.reduce((acc, it) => acc + (Number(it?.quantity || 0)), 0);
  // Volume not available by default; treat as 0 for now
  const totalCbm = 0;

  // Fetch rules for this shop and country
  const allRules = await prisma.shippingRule.findMany({
    where: { shop },
    include: { ranges: true },
  });

  // Filter rules that include destination country
  const destNorm = normalizeCountry(destinationCountry);
  const matchedRules = allRules.filter((r) => {
    try {
      const arr = Array.isArray(r.countries) ? r.countries : [];
      const normArr = arr.map((c) => normalizeCountry(c));
      return normArr.includes(destNorm);
    } catch (_) {
      return false;
    }
  });

  // Compute candidate rates
  const rates = [];
  for (const rule of matchedRules) {
    const measure = rule.chargeBy;
    const value = measure === "weight" ? totalKg : measure === "volume" ? totalCbm : totalQty;

    // Find first matching range
    // 为了让边界值（例如相邻区间的交界点）优先匹配“前一个区间”，
    // 这里先按 fromVal 升序排序后再查找，这样 [0,10]、[10,20] 且都为闭区间时，value=10 会命中前者。
    const sortedRanges = [...(Array.isArray(rule.ranges) ? rule.ranges : [])]
      .sort((a, b) => Number(a.fromVal) - Number(b.fromVal));
    const range = sortedRanges.find(
      (rg) => value >= Number(rg.fromVal) && value <= Number(rg.toVal)
    );
    if (!range) continue;

    // price = pricePer * value + fee
    const priceRmb = Number(range.pricePer) * Number(value) + Number(range.fee);

    // For simplicity: return currency as CNY, Shopify will display according to shop settings; Alternatively convert if needed
    rates.push({
      service_name: rule.name,
      service_code: `ECOCJ_${rule.id.slice(-6)}`,
      total_price: Math.max(0, Math.round(priceRmb * 100)).toString(), // cents
      currency: currency || range.feeUnit || "CNY",
      description: rule.description || `${measure} based rate`,
      // min/max delivery date optional
    });
  }

  // Debug logs for development
  try {
    if (skipHmac) {
      console.log("[carrier.callback] DEV_SKIP_HMAC=true (dev mode)");
    }
    console.log("[carrier.callback] shop=", shop,
      "destCountry=", destinationCountry,
      "destNorm=", destNorm,
      "items=", items?.length || 0,
      "totalKg=", totalKg,
      "totalQty=", totalQty,
      "rules=", allRules?.length || 0,
      "matchedRules=", matchedRules?.length || 0,
      "rates=", rates?.length || 0);
  } catch {}

  return json({ rates });
};

export const loader = async () => json({ ok: true });
