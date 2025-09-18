import { useMemo, useState, useEffect, useRef } from "react";
import { useNavigate, useLoaderData, useFetcher, useRevalidator } from "@remix-run/react";
import {
  Page,
  Text,
  Card,
  Button,
  BlockStack,
  Box,
  Checkbox,
  InlineStack,
  Modal,
  Banner,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { json } from "@remix-run/node";
import { DeleteIcon } from "@shopify/polaris-icons";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session?.shop || null;

  // Ensure CarrierService exists for this shop
  try {
    // List all carrier services via generic REST client
    const listResp = await admin.rest.get({ path: 'carrier_services.json' });
    const services = listResp?.body?.carrier_services || [];
    const NAME = "ECOCJ Carrier";
    const origin = process.env.SHOPIFY_APP_URL && process.env.SHOPIFY_APP_URL.trim().length > 0
      ? process.env.SHOPIFY_APP_URL
      : new URL(request.url).origin;
    const callbackUrl = `${origin}/api/carrier/callback`;

    const exists = services.find((s) => (s?.name || s?.service_name) === NAME);
    if (!exists) {
      await admin.rest.post({
        path: 'carrier_services.json',
        data: {
          carrier_service: {
            name: NAME,
            callback_url: callbackUrl,
            service_discovery: true,
          },
        },
        type: 'application/json',
      });
    } else {
      // Optionally keep callback up-to-date
      const id = exists.id || exists.admin_graphql_api_id || exists?.carrier_service?.id;
      try {
        await admin.rest.put({
          path: `carrier_services/${id}.json`,
          data: {
            carrier_service: {
              name: NAME,
              callback_url: callbackUrl,
              service_discovery: true,
            },
          },
          type: 'application/json',
        });
      } catch (_) {
        // ignore update failure
      }
    }
  } catch (e) {
    // Fail silently to not block app UI
    console.warn("CarrierService ensure failed", e);
  }

  // Load backend shipping rules for this shop
  let rules = [];
  if (shop) {
    try {
      rules = await prisma.shippingRule.findMany({
        where: { shop },
        include: { ranges: true },
        orderBy: { createdAt: 'desc' },
      });
    } catch (e) {
      console.warn('Load rules failed', e);
    }
  }

  return { shop, rules };
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session?.shop || null;

  const formData = await request.formData();
  const intent = formData.get("_action");

  // Handle delete rule
  if (intent === "delete") {
    try {
      if (!shop) {
        return json({ ok: false, error: "缺少店铺信息" }, { status: 400 });
      }

      let ids = [];
      const idsJson = formData.get("ids");
      const idRaw = formData.get("id");
      if (idsJson) {
        try {
          const parsed = JSON.parse(idsJson);
          if (Array.isArray(parsed)) ids = parsed;
        } catch (_) {}
      } else if (idRaw) {
        ids = [idRaw];
      }

      ids = ids
        .map((v) => {
          const n = Number(v);
          return Number.isNaN(n) ? v : n;
        })
        .filter((v) => v !== undefined && v !== null);

      if (ids.length === 0) {
        return json({ ok: false, error: "未提供要删除的ID" }, { status: 400 });
      }

      // 查找属于当前店铺的规则，避免越权
      const rules = await prisma.shippingRule.findMany({ where: { id: { in: ids }, shop } });
      const ruleIds = rules.map((r) => r.id);
      if (ruleIds.length === 0) {
        return json({ ok: false, error: "未找到对应规则或无权限" }, { status: 404 });
      }

      // 先删子表，再删主表
      await prisma.shippingRange.deleteMany({ where: { ruleId: { in: ruleIds } } });
      const del = await prisma.shippingRule.deleteMany({ where: { id: { in: ruleIds } } });

      return json({ ok: true, deleted: del.count, requested: ids.length });
    } catch (e) {
      console.warn("Delete rule failed", e);
      return json({ ok: false, error: "删除失败" }, { status: 500 });
    }
  }

  // fallback: original demo mutation (kept for reference, not used by UI now)
  const color = ["Red", "Orange", "Yellow", "Green"][
    Math.floor(Math.random() * 4)
  ];
  const response = await admin.graphql(
    `#graphql
      mutation populateProduct($product: ProductCreateInput!) {
        productCreate(product: $product) {
          product {
            id
            title
            handle
            status
            variants(first: 10) {
              edges {
                node {
                  id
                  price
                  barcode
                  createdAt
                }
              }
            }
          }
        }
      }`,
    {
      variables: {
        product: {
          title: `${color} Snowboard`,
        },
      },
    },
  );
  const responseJson = await response.json();
  const product = responseJson.data.productCreate.product;
  const variantId = product.variants.edges[0].node.id;
  const variantResponse = await admin.graphql(
    `#graphql
    mutation shopifyRemixTemplateUpdateVariant($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        productVariants {
          id
          price
          barcode
          createdAt
        }
      }
    }`,
    {
      variables: {
        productId: product.id,
        variants: [{ id: variantId, price: "100.00" }],
      },
    },
  );
  const variantResponseJson = await variantResponse.json();

  return {
    product: responseJson.data.productCreate.product,
    variant: variantResponseJson.data.productVariantsBulkUpdate.productVariants,
  };
};

export default function Index() {
  const data = useLoaderData();
  const navigate = useNavigate();
  const fetcher = useFetcher();
  const revalidator = useRevalidator();
  const pendingDeleteRef = useRef(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleteIds, setDeleteIds] = useState([]);
  const [bannerMsg, setBannerMsg] = useState(null);
  const [bannerTone, setBannerTone] = useState("info");

  // 国家代码 -> 中文名（找不到则回退为代码）
  const countryNameMap = useMemo(
    () => ({
      US: "美国",
      CA: "加拿大",
      CN: "中国",
      GB: "英国",
      DE: "德国",
      FR: "法国",
      AU: "澳大利亚",
      JP: "日本",
      HK: "中国香港",
      MO: "中国澳门",
      TW: "中国台湾",
    }),
    [],
  );

  // 将后端规则转换为前端显示用结构
  const rates = useMemo(() => {
    const rules = Array.isArray(data?.rules) ? data.rules : [];
    return rules.map((r) => ({
      id: r.id,
      title: r.name,
      description: r.description || "",
      chargeBy: r.chargeBy,
      countriesSelected: Array.isArray(r.countries) ? r.countries : [],
      ranges: Array.isArray(r.ranges)
        ? r.ranges.map((rg) => ({
            from: String(rg.fromVal),
            to: String(rg.toVal),
            unit: rg.unit,
            pricePer: String(rg.pricePer),
            fee: String(rg.fee),
            feeUnit: rg.feeUnit,
          }))
        : [],
    }));
  }, [data?.rules]);

  // 选择状态
  const [selected, setSelected] = useState(new Set());
  const allSelected = selected.size === rates.length && rates.length > 0;
  const someSelected = selected.size > 0 && !allSelected;

  // 悬浮行索引，用于显示明显的 hover 背景
  const [hoverIdx, setHoverIdx] = useState(null);

  const toggleOne = (id, checked) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  };

  const toggleAll = (checked) => {
    if (checked) {
      setSelected(new Set(rates.map((_, i) => i)));
    } else {
      setSelected(new Set());
    }
  };

  // 打开编辑（新建）页面，并传递可编辑草稿数据
  const openEdit = (rate) => {
    const draft = {
      ruleName: rate.title || "",
      calcType: rate.calcType || "custom",
      chargeBy: rate.chargeBy || "weight",
      countriesSelected: Array.isArray(rate.countriesSelected) ? rate.countriesSelected : [],
      ranges: Array.isArray(rate.ranges) && rate.ranges.length
        ? rate.ranges
        : [
            { from: "0", to: "0.5", unit: "KG", pricePer: "100", fee: "20", feeUnit: "CNY" },
            { from: "0.5", to: "1", unit: "KG", pricePer: "90", fee: "20", feeUnit: "CNY" },
          ],
      description: rate.description || "",
    };
    navigate("/app/shipping/new", { state: { draft } });
  };

  const onDelete = (ruleId) => {
    setDeleteIds([String(ruleId)]);
    setConfirmOpen(true);
  };

  const onBatchDelete = () => {
    const ids = Array.from(selected).map((idx) => String(rates[idx]?.id)).filter(Boolean);
    if (ids.length === 0) return;
    setDeleteIds(ids);
    setConfirmOpen(true);
  };

  const confirmDelete = () => {
    pendingDeleteRef.current = true;
    // 支持批量删除
    const body = { _action: "delete" };
    if (deleteIds.length === 1) body.id = deleteIds[0];
    else body.ids = JSON.stringify(deleteIds);
    fetcher.submit(body, { method: "post" });
  };

  // 删除完成后，主动触发页面 revalidate，确保列表刷新
  useEffect(() => {
    if (pendingDeleteRef.current && fetcher.state === "idle" && fetcher.formData == null) {
      pendingDeleteRef.current = false;
      setConfirmOpen(false);
      const ok = fetcher.data?.ok === true;
      if (ok) {
        setBannerTone("success");
        setBannerMsg(`删除成功：${fetcher.data?.deleted ?? 0} 条`);
        // 清空选择
        setSelected(new Set());
        // 重新拉取数据
        revalidator.revalidate();
      } else {
        setBannerTone("critical");
        setBannerMsg(fetcher.data?.error || "删除失败");
      }
    }
    // 仅在提交状态变化时检查
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.state]);

  return (
    <Page>
      <TitleBar title="Table Rates Shipping" />
      <BlockStack gap="500">
        {/* 顶部标题与操作区 */}
        <InlineStack align="space-between" blockAlign="center">
          <InlineStack gap="300" blockAlign="center">
            <Text as="h1" variant="headingLg">
              运费管理
            </Text>
            {/* <Badge>
              运费管理
            </Badge> */}
          </InlineStack>
          <InlineStack gap="300" blockAlign="center">
            <Button url={`/app/api/carriers${data?.shop ? `?shop=${encodeURIComponent(data.shop)}` : ""}`}>查看 CarrierService</Button>
            <Button url={`/app/api/carriers/ensure${data?.shop ? `?shop=${encodeURIComponent(data.shop)}` : ""}`}>强制创建 CarrierService</Button>
            <Button variant="primary" url="/app/shipping/new">添加运费规则</Button>
          </InlineStack>
        </InlineStack>

        {/* 列表卡片 / 空状态 */}
        {rates.length === 0 ? (
          <Card>
            <Box padding="400">
              <BlockStack gap="300">
                <Text as="p" variant="bodyMd">暂时没有运费规则。</Text>
                <InlineStack gap="300">
                  <Button variant="primary" url="/app/shipping/new">立即添加运费规则</Button>
                  <Button url={`/app/api/carriers${data?.shop ? `?shop=${encodeURIComponent(data.shop)}` : ""}`}>查看 CarrierService</Button>
                </InlineStack>
              </BlockStack>
            </Box>
          </Card>
        ) : (
          <Card>
            <BlockStack gap="0">
            {/* 工具条 */}
            <Box padding="300" borderBlockEndWidth="025" borderColor="border">
              <InlineStack align="space-between" blockAlign="center">
                <InlineStack gap="300" blockAlign="center">
                  <Checkbox
                    label=""
                    checked={allSelected}
                    indeterminate={someSelected}
                    onChange={(checked) => toggleAll(checked)}
                  />
                  <Text variant="bodyMd">{rates.length} 条运费规则</Text>
                </InlineStack>
                {selected.size > 0 && (
                  <Button
                    tone="critical"
                    variant="plain"
                    icon={DeleteIcon}
                    onClick={onBatchDelete}
                    disabled={fetcher.state !== "idle"}
                  >
                    删除选中（{selected.size}）
                  </Button>
                )}
              </InlineStack>
            </Box>

            {/* 列表项 */}
            {rates.map((rate, idx) => (
              <div
                key={idx}
                style={{ cursor: "pointer", backgroundColor: hoverIdx === idx ? "rgba(0,0,0,0.06)" : undefined,
                  transition: "background-color 120ms ease", }}
                onClick={() => openEdit(rate)}
                onMouseEnter={() => setHoverIdx(idx)}
                onMouseLeave={() => setHoverIdx(null)}
              >
                <Box
                  padding="400"
                  borderBlockEndWidth={idx === rates.length - 1 ? undefined : "025"}
                  borderColor="border"
                  borderRadius="150"
                  minHeight="56px"
                >
                <InlineStack align="space-between" blockAlign="center" gap="400">
                  {/* 左侧：选择框 + 图标（可选） + 文本，禁止自动换行 */}
                  <InlineStack gap="300" blockAlign="center" wrap={false}>
                    <Box onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        label=""
                        checked={selected.has(idx)}
                        onChange={(checked) => toggleOne(idx, checked)}
                      />
                    </Box>
                    {/* <Icon source={ListBulletedIcon} tone="subdued" /> */}
                    <BlockStack gap="050">
                      <Text as="h3" variant="headingMd">
                        {rate.title}
                      </Text>
                      <Text as="p" variant="bodySm" tone="subdued">
                        {rate.description}
                      </Text>
                      {/* 国家/地区展示 */}
                      <Text as="p" variant="bodySm">
                        国家/地区：
                        {Array.isArray(rate.countriesSelected) && rate.countriesSelected.length > 0
                          ? rate.countriesSelected
                              .map((c) => countryNameMap[c] || c)
                              .join("，")
                          : "未设置"}
                      </Text>
                    </BlockStack>
                  </InlineStack>

                  {/* 右侧：删除图标按钮 */}
                  <Box onClick={(e) => e.stopPropagation()}>
                    <Button
                      variant="plain"
                      tone="critical"
                      icon={DeleteIcon}
                      accessibilityLabel="删除运费规则"
                      onClick={() => onDelete(rate.id)}
                      disabled={fetcher.state !== "idle"}
                    />
                  </Box>
                </InlineStack>
                </Box>
              </div>
            ))}
          </BlockStack>
        </Card>
        )}
      {/* 全局结果提示 */}
      {bannerMsg && (
        <Box padding="300">
          <Banner tone={bannerTone} onDismiss={() => setBannerMsg(null)}>
            {bannerMsg}
          </Banner>
        </Box>
      )}

      {/* 删除确认弹窗 */}
      <Modal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title="确认删除"
        primaryAction={{
          content: fetcher.state !== "idle" ? "删除中..." : "删除",
          destructive: true,
          onAction: confirmDelete,
          disabled: fetcher.state !== "idle",
        }}
        secondaryActions={[{ content: "取消", onAction: () => setConfirmOpen(false), disabled: fetcher.state !== "idle" }]}
      >
        <Box padding="400">
          <Text as="p" variant="bodyMd">
            确定删除 {deleteIds.length} 条运费规则吗？该操作不可恢复。
          </Text>
        </Box>
      </Modal>

      </BlockStack>
    </Page>
  );
}
