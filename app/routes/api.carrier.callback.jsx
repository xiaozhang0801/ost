import crypto from "crypto";
import { json } from "@remix-run/node";
import prisma from "../db.server";

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
  const matchedRules = allRules.filter((r) => {
    try {
      const arr = Array.isArray(r.countries) ? r.countries : [];
      return arr.includes(destinationCountry);
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
    const range = rule.ranges.find((rg) => value >= Number(rg.fromVal) && value <= Number(rg.toVal));
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
