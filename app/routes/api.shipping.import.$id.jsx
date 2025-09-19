import { json } from "@remix-run/node";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";

function normalizeCountry(input) {
  if (!input && input !== 0) return "";
  const raw = String(input).trim();
  if (!raw) return "";
  const up = raw.toUpperCase();
  const map = {
    CN: "CN", CHN: "CN", CHINA: "CN", "中国": "CN", "中國": "CN",
    US: "US", USA: "US", UNITEDSTATES: "US", "UNITED STATES": "US", "美国": "US", "美國": "US",
    CA: "CA", CAN: "CA", CANADA: "CA", "加拿大": "CA",
    GB: "GB", UK: "GB", GBR: "GB", UNITEDKINGDOM: "GB", "UNITED KINGDOM": "GB", "英国": "GB", "英國": "GB",
    DE: "DE", DEU: "DE", GERMANY: "DE", "德国": "DE", "德國": "DE",
    FR: "FR", FRA: "FR", FRANCE: "FR", "法国": "FR", "法國": "FR",
    AU: "AU", AUS: "AU", AUSTRALIA: "AU", "澳大利亚": "AU", "澳大利亞": "AU",
    JP: "JP", JPN: "JP", JAPAN: "JP", "日本": "JP",
    HK: "HK", HKG: "HK", HONGKONG: "HK", "HONG KONG": "HK", "香港": "HK",
    MO: "MO", MAC: "MO", MACAU: "MO", "澳门": "MO", "澳門": "MO",
    TW: "TW", TWN: "TW", TAIWAN: "TW", "台湾": "TW", "臺灣": "TW",
  };
  const key = up.replace(/\s+/g, "");
  return map[key] || up;
}

function parseExcel2003Xml(xmlText) {
  // 提取所有行
  const rowRegex = /<Row[\s\S]*?>[\s\S]*?<\/Row>/gi;
  const cellRegex = /<Cell[\s\S]*?>\s*<Data[^>]*>([\s\S]*?)<\/Data>\s*<\/Cell>/gi;
  const rows = [];
  let rowMatch;
  while ((rowMatch = rowRegex.exec(xmlText))) {
    const rowXml = rowMatch[0];
    const cells = [];
    let cellMatch;
    while ((cellMatch = cellRegex.exec(rowXml))) {
      // 反转义 XML 实体
      const raw = String(cellMatch[1] || "");
      const val = raw
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'");
      cells.push(val.trim());
    }
    rows.push(cells);
  }
  return rows;
}

export const action = async ({ request, params }) => {
  const { session } = await authenticate.admin(request);
  const shop = session?.shop;
  if (!shop) return json({ error: "Unauthorized" }, { status: 401 });

  const id = params?.id || "";
  if (!id) return json({ error: "Missing id" }, { status: 400 });

  const existing = await prisma.shippingRule.findFirst({ where: { id, shop }, include: { ranges: true } });
  if (!existing) return json({ error: "未找到对应规则或无权限" }, { status: 404 });

  const form = await request.formData();
  const file = form.get("file");
  if (!file) return json({ error: "缺少文件" }, { status: 400 });

  let text;
  if (typeof file.text === "function") {
    text = await file.text();
  } else {
    // 兼容某些环境
    const arrBuf = await file.arrayBuffer();
    text = Buffer.from(arrBuf).toString("utf8");
  }

  const rows = parseExcel2003Xml(text);
  if (!rows.length) return json({ error: "文件内容为空或格式不正确" }, { status: 400 });

  // 读取表头并定位列
  const header = (rows[0] || []).map((h) => String(h || "").trim());
  const idx = {
    method: header.findIndex((h) => /^(method)$/i.test(h)),
    countries: header.findIndex((h) => /^(countries)$/i.test(h)),
    from: header.findIndex((h) => /^(from)$/i.test(h)),
    to: header.findIndex((h) => /^(to)$/i.test(h)),
    unit: header.findIndex((h) => /^(unit)$/i.test(h)),
    additionalFee: header.findIndex((h) => /^(additional\s*fee)$/i.test(h)),
    baseFee: header.findIndex((h) => /^(base\s*fee)$/i.test(h)),
    currencyUnit: header.findIndex((h) => /^(currency\s*unit)$/i.test(h)),
  };

  const requiredCols = ["method", "countries", "from", "to", "unit", "additionalFee", "baseFee", "currencyUnit"];
  for (const k of requiredCols) {
    if (idx[k] === -1) {
      return json({ error: `缺少列: ${k}` }, { status: 400 });
    }
  }

  // 逐行解析（跳过表头）
  const dataRows = rows.slice(1).filter((r) => (r || []).some((c) => String(c || "").trim() !== ""));
  if (!dataRows.length) return json({ error: "没有可导入的数据行" }, { status: 400 });

  // 取第一行 method 与 countries 作为整体属性
  const methodCell = String(dataRows[0][idx.method] || existing.chargeBy || "weight").trim();
  const chargeBy = /^(weight|volume|quantity)$/i.test(methodCell) ? methodCell.toLowerCase() : existing.chargeBy;

  const countriesCell = String(dataRows[0][idx.countries] || "").trim();
  // 仅支持英文逗号 , 分隔；如检测到 | 或全角逗号，直接报错
  if (/[|，]/.test(countriesCell)) {
    return json({ error: "国家分隔符仅支持英文逗号 , ，请修改文件后重试" }, { status: 400 });
  }
  const countries = countriesCell
    ? countriesCell
        .split(',')
        .map((s) => normalizeCountry(s))
        .filter(Boolean)
    : [];

  const unitDefault = chargeBy === "volume" ? "CBM" : chargeBy === "quantity" ? "件" : "KG";

  const ranges = dataRows.map((r) => {
    const fromVal = Number(r[idx.from] ?? 0);
    const toVal = Number(r[idx.to] ?? 0);
    const unit = String(r[idx.unit] || unitDefault).trim() || unitDefault;
    const pricePer = Number(r[idx.additionalFee] ?? 0);
    const fee = Number(r[idx.baseFee] ?? 0);
    const feeUnit = String(r[idx.currencyUnit] || "CNY").trim() || "CNY";
    return { fromVal, toVal, unit, pricePer, fee, feeUnit };
  }).sort((a, b) => (a.fromVal - b.fromVal) || (a.toVal - b.toVal));

  // 仅返回解析结果，不落库；由前端更新表单，用户点击“保存”后再调用 /api/shipping/rules 持久化
  const preview = {
    id,
    name: existing.name, // 不修改名称
    chargeBy,
    countries,
    ranges,
  };

  return json({ rule: preview, imported: true, persisted: false });
};
