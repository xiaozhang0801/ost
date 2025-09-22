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

// 校验区间有效性：返回错误数组（含索引与消息）
function validateRangesForCharge(ranges, chargeBy) {
  const errs = [];
  const isQuantity = chargeBy === "quantity";
  const list = Array.isArray(ranges) ? ranges : [];
  list.forEach((r, idx) => {
    const a = Number(r.fromVal ?? r.from ?? 0);
    const b = Number(r.toVal ?? r.to ?? 0);
    if (Number.isNaN(a) || Number.isNaN(b)) {
      errs.push({ index: idx, message: "范围起止必须为数字" });
      return;
    }
    if (b < a) {
      errs.push({ index: idx, message: "范围止必须≥范围起" });
    }
    if (isQuantity) {
      if (!Number.isInteger(a) || !Number.isInteger(b) || a < 1 || b < 1) {
        errs.push({ index: idx, message: "按件计费时范围必须为≥1的整数" });
      }
    } else {
      if (a < 0 || b < 0) {
        errs.push({ index: idx, message: "范围不得为负数" });
      }
    }
    const pricePer = Number(r.pricePer ?? 0);
    const fee = Number(r.fee ?? 0);
    if (pricePer < 0 || Number.isNaN(pricePer)) {
      errs.push({ index: idx, message: "运费单价必须为非负数" });
    }
    if (fee < 0 || Number.isNaN(fee)) {
      errs.push({ index: idx, message: "挂号费必须为非负数" });
    }
  });
  // 跨段校验：第 i 段的起始值必须 ≥ 第 i-1 段的最大值（假定已按 fromVal、toVal 排序）
  for (let i = 1; i < list.length; i++) {
    const prevTo = Number(list[i - 1].toVal ?? list[i - 1].to ?? 0);
    const currFrom = Number(list[i].fromVal ?? list[i].from ?? 0);
    if (!Number.isNaN(prevTo) && !Number.isNaN(currFrom) && currFrom < prevTo) {
      errs.push({ index: i, message: "范围起必须≥上一区间的范围止" });
    }
  }
  return errs;
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
    id = null,
    name = "",
    chargeBy = "weight",
    countries = [],
    description = null,
    ranges = [],
  } = payload || {};

  const normName = String(name || "").trim();

  if (!normName || !Array.isArray(ranges) || ranges.length === 0) {
    return json({ error: "参数不完整", code: "BAD_REQUEST" }, { status: 400 });
  }

  // 标准化国家列表：支持字符串或对象格式
  const normalizedCountries = Array.isArray(countries)
    ? countries
        .map((c) => (typeof c === 'string' ? c : (c?.code || c?.value || c?.label || '')))
        .map((c) => normalizeCountry(c))
        .filter(Boolean)
    : [];

  // 如果带有 id，则执行更新（需校验归属）
  if (id) {
    // 先查是否归属于当前店铺
    const existing = await prisma.shippingRule.findFirst({ where: { id, shop }, include: { ranges: true } });
    if (!existing) {
      return json({ error: "未找到对应规则或无权限" }, { status: 404 });
    }

    // 名称唯一性校验：同一店铺下，不允许与其他规则重名
    const conflict = await prisma.shippingRule.findFirst({
      where: {
        shop,
        name: normName,
        id: { not: id },
      },
      select: { id: true },
    });
    if (conflict) {
      return json({ error: "名称已存在，请修改后再保存", code: "NAME_DUPLICATE" }, { status: 409 });
    }

    // 事务：更新主表，重建子表 ranges
    // 先对 ranges 做标准化与排序（fromVal 升序，若相同再按 toVal 升序）
    const normalizedSortedRanges = (Array.isArray(ranges) ? ranges : [])
      .map((r) => ({
        fromVal: Number(r.from ?? r.fromVal ?? 0),
        toVal: Number(r.to ?? r.toVal ?? 0),
        unit: r.unit || (chargeBy === "volume" ? "CBM" : chargeBy === "quantity" ? "件" : "KG"),
        pricePer: Number(r.pricePer ?? 0),
        fee: Number(r.fee ?? 0),
        feeUnit: r.feeUnit || "USD",
      }))
      .sort((a, b) => (a.fromVal - b.fromVal) || (a.toVal - b.toVal));

    // 服务端区间校验（与前端一致），失败返回 422 并附带 fieldErrors
    const rangeErrors = validateRangesForCharge(normalizedSortedRanges, chargeBy);
    if (Array.isArray(rangeErrors) && rangeErrors.length > 0) {
      return json({ error: "区间设置不合法", code: "INVALID_RANGES", fieldErrors: { ranges: rangeErrors } }, { status: 422 });
    }

    const [, updated] = await prisma.$transaction([
      prisma.shippingRange.deleteMany({ where: { ruleId: id } }),
      prisma.shippingRule.update({
        where: { id },
        data: {
          name: normName,
          chargeBy,
          countries: normalizedCountries,
          description,
          ranges: {
            create: normalizedSortedRanges,
          },
        },
        include: { ranges: true },
      }),
    ]);

    return json({ rule: updated, updated: true });
  }

  // 否则：创建
  // 创建前同样做标准化与排序
  const normalizedSortedRangesCreate = (Array.isArray(ranges) ? ranges : [])
    .map((r) => ({
      fromVal: Number(r.from ?? r.fromVal ?? 0),
      toVal: Number(r.to ?? r.toVal ?? 0),
      unit: r.unit || (chargeBy === "volume" ? "CBM" : chargeBy === "quantity" ? "件" : "KG"),
      pricePer: Number(r.pricePer ?? 0),
      fee: Number(r.fee ?? 0),
      feeUnit: r.feeUnit || "USD",
    }))
    .sort((a, b) => (a.fromVal - b.fromVal) || (a.toVal - b.toVal));

  // 名称唯一性校验（创建）：同店铺不允许重名
  const existsSameName = await prisma.shippingRule.findFirst({
    where: { shop, name: normName },
    select: { id: true },
  });
  if (existsSameName) {
    return json({ error: "名称已存在，请修改后再保存", code: "NAME_DUPLICATE" }, { status: 409 });
  }

  // 服务端区间校验（与前端一致），失败返回 422 并附带 fieldErrors
  const createRangeErrors = validateRangesForCharge(normalizedSortedRangesCreate, chargeBy);
  if (Array.isArray(createRangeErrors) && createRangeErrors.length > 0) {
    return json({ error: "区间设置不合法", code: "INVALID_RANGES", fieldErrors: { ranges: createRangeErrors } }, { status: 422 });
  }

  const rule = await prisma.shippingRule.create({
    data: {
      shop,
      name: normName,
      chargeBy,
      countries: normalizedCountries,
      description,
      ranges: {
        create: normalizedSortedRangesCreate,
      },
    },
    include: { ranges: true },
  });

  return json({ rule, created: true });
};
