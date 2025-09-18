import { json } from "@remix-run/node";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session?.shop;
  if (!shop) return json({ error: "Unauthorized" }, { status: 401 });

  const rules = await prisma.shippingRule.findMany({
    where: { shop },
    include: { ranges: true },
    orderBy: { createdAt: "desc" },
  });
  return json({ rules });
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

  // Create rule with nested ranges
  const rule = await prisma.shippingRule.create({
    data: {
      shop,
      name,
      chargeBy,
      countries: countries,
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
