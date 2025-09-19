import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { json } from "@remix-run/node";

function xmlEscape(value) {
  const str = value == null ? "" : String(value);
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export const loader = async ({ request, params }) => {
  const { session } = await authenticate.admin(request);
  const shop = session?.shop;
  if (!shop) {
    return json({ error: "Unauthorized" }, { status: 401 });
  }

  const id = params?.id || "";
  if (!id) {
    return json({ error: "Missing id" }, { status: 400 });
  }

  const rule = await prisma.shippingRule.findFirst({
    where: { id, shop },
    include: { ranges: true },
  });

  if (!rule) {
    return json({ error: "Not found" }, { status: 404 });
  }

  // 组装 Excel 2003 XML（.xls），不包含规则名称；文件名使用规则名称
  const headers = [
    "Method",
    "countries",
    "from",
    "to",
    "unit",
    "Additional fee",
    "Base fee",
    "Currency Unit",
  ];

  const countries = Array.isArray(rule.countries)
    ? rule.countries
        .map((c) => (typeof c === 'string' ? c : (c?.code || c?.value || c?.label || ''))) 
        .filter(Boolean)
    : [];
  const countriesCell = countries.join("|"); // 用 | 连接，导入时再拆

  // 导出前按 fromVal、toVal 升序排序，统一顺序
  const sortedRanges = [...(Array.isArray(rule.ranges) ? rule.ranges : [])]
    .sort((a, b) => (Number(a.fromVal) - Number(b.fromVal)) || (Number(a.toVal) - Number(b.toVal)));

  const rows = [headers, ...sortedRanges.map((r) => [
    rule.chargeBy,
    countriesCell,
    r.fromVal,
    r.toVal,
    r.unit,
    r.pricePer,
    r.fee,
    r.feeUnit,
  ])];

  const xmlHeader = `<?xml version="1.0"?>\n` +
    `<?mso-application progid="Excel.Sheet"?>\n` +
    `<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" ` +
    `xmlns:o="urn:schemas-microsoft-com:office:office" ` +
    `xmlns:x="urn:schemas-microsoft-com:office:excel" ` +
    `xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet" ` +
    `xmlns:html="http://www.w3.org/TR/REC-html40">`;

  const sheetName = xmlEscape(rule.name || "shipping-rule");
  const xmlRows = rows
    .map((cols) => {
      const cells = cols
        .map((c) => {
          const isNumber = typeof c === "number" || (typeof c === "string" && /^-?\d+(\.\d+)?$/.test(c));
          if (isNumber) {
            return `<Cell><Data ss:Type="Number">${c}</Data></Cell>`;
          }
          return `<Cell><Data ss:Type="String">${xmlEscape(c)}</Data></Cell>`;
        })
        .join("");
      return `<Row>${cells}</Row>`;
    })
    .join("");

  const xmlContent = `${xmlHeader}
    <Worksheet ss:Name="${sheetName}">
      <Table>
        ${xmlRows}
      </Table>
    </Worksheet>
  </Workbook>`;

  const fileName = `${rule.name || 'shipping-rule'}.xls`;

  return new Response(xmlContent, {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.ms-excel; charset=utf-8",
      "Content-Disposition": `attachment; filename="${encodeURIComponent(fileName)}"`,
      "Cache-Control": "no-store",
    },
  });
};
