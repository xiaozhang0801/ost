import { useMemo, useState } from "react";
import { useNavigate } from "@remix-run/react";
import {
  Page,
  Text,
  Card,
  Button,
  BlockStack,
  Box,
  Checkbox,
  InlineStack,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  await authenticate.admin(request);

  return null;
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
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
  const navigate = useNavigate();
  // 模拟运费模板数据
  const rates = useMemo(
    () => [
      {
        title: "美国运费",
        description: "空运",
        calcType: "custom",
        chargeBy: "weight",
        countriesSelected: ["US", "CA"],
        ranges: [
          { from: "0", to: "0.5", unit: "KG", pricePer: "120", fee: "20", feeUnit: "CNY" },
          { from: "0.5", to: "1", unit: "KG", pricePer: "110", fee: "20", feeUnit: "CNY" },
        ],
      },
      {
        title: "内地运费",
        description: "顺丰",
        calcType: "custom",
        chargeBy: "volume",
        countriesSelected: ["GB", "DE", "FR"],
        ranges: [
          { from: "0", to: "0.1", unit: "CBM", pricePer: "800", fee: "30", feeUnit: "CNY" },
          { from: "0.1", to: "0.2", unit: "CBM", pricePer: "750", fee: "30", feeUnit: "CNY" },
        ],
      },
      {
        title: "港澳运费",
        description:
          "空运",
        calcType: "custom",
        chargeBy: "quantity",
        countriesSelected: ["AU", "JP"],
        ranges: [
          { from: "1", to: "5", unit: "件", pricePer: "30", fee: "10", feeUnit: "CNY" },
          { from: "6", to: "10", unit: "件", pricePer: "28", fee: "10", feeUnit: "CNY" },
        ],
      },
      {
        title: "国际运费",
        description:
          "海运",
        calcType: "fixed",
        chargeBy: "weight",
        countriesSelected: ["US"],
        ranges: [
          { from: "0", to: "1", unit: "KG", pricePer: "95", fee: "15", feeUnit: "CNY" },
        ],
      },
      {
        title: "欧洲运费",
        description: "海运",
        calcType: "custom",
        chargeBy: "weight",
        countriesSelected: ["CN"],
        ranges: [
          { from: "0", to: "0.2", unit: "KG", pricePer: "130", fee: "12", feeUnit: "CNY" },
          { from: "0.2", to: "0.5", unit: "KG", pricePer: "115", fee: "12", feeUnit: "CNY" },
        ],
      },
    ],
    [],
  );

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
            {/* <Link url="#" removeUnderline>
              Plans
            </Link> */}
            <Button variant="primary" url="/app/shipping/new">添加运费规则</Button>
          </InlineStack>
        </InlineStack>

        {/* 列表卡片 */}
        <Card>
          <BlockStack gap="0">
            {/* 工具条 */}
            <Box padding="300" borderBlockEndWidth="025" borderColor="border">
              <InlineStack gap="300" blockAlign="center">
                <Checkbox
                  label=""
                  checked={allSelected}
                  indeterminate={someSelected}
                  onChange={(checked) => toggleAll(checked)}
                />
                <Text variant="bodyMd">{rates.length} 条运费规则</Text>
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
                    </BlockStack>
                  </InlineStack>

                  {/* 右侧：状态 */}
                  {/* <Badge tone="success">Active</Badge> */}
                </InlineStack>
                </Box>
              </div>
            ))}
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
