import { useState, useEffect, useCallback, useRef } from "react";
import { useLoaderData, useLocation, useNavigate } from "@remix-run/react";
import {
  Page,
  Card,
  BlockStack,
  InlineStack,
  InlineGrid,
  Text,
  Select,
  TextField,
  Button,
  Box,
  Divider,
  Autocomplete,
  Tag,
  ButtonGroup,
  Banner,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";

// 简易内存缓存：避免每次进入页面都请求外部接口
let __countries_cache = null;
let __countries_cache_at = 0;
const COUNTRIES_TTL_MS = 24 * 60 * 60 * 1000; // 24小时

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  const now = Date.now();
  if (__countries_cache && now - __countries_cache_at < COUNTRIES_TTL_MS) {
    return { countries: __countries_cache };
  }
  try {
    const res = await fetch(
      "https://restcountries.com/v3.1/all?fields=name,cca2",
    );
    const json = await res.json();
    const countries = (Array.isArray(json) ? json : [])
      .map((c) => ({ label: c?.name?.common || c?.cca2 || "Unknown", value: c?.cca2 || "" }))
      // 如果接口返回 Taiwan（或 TW），重命名为 Taiwan (Province of China)
      .map((o) =>
        o && (o.value === "TW" || o.label === "Taiwan")
          ? { ...o, label: "Taiwan (Province of China)" }
          : o
      )
      .filter((o) => o.value)
      .sort((a, b) => a.label.localeCompare(b.label));
    __countries_cache = countries;
    __countries_cache_at = now;
    return { countries };
  } catch (e) {
    // 回退到常见国家列表
    const countries = [
      { label: "United States", value: "US" },
      { label: "China", value: "CN" },
      { label: "Canada", value: "CA" },
      { label: "United Kingdom", value: "GB" },
      { label: "Australia", value: "AU" },
      { label: "Germany", value: "DE" },
      { label: "France", value: "FR" },
      { label: "Japan", value: "JP" },
    ];
    __countries_cache = countries;
    __countries_cache_at = now;
    return { countries };
  }
};

export default function ShippingRateNew() {
  const { countries } = useLoaderData();
  const location = useLocation();
  const navigate = useNavigate();
  const draft = location?.state?.draft;
  const [ruleId, setRuleId] = useState("");
  const [chargeBy, setChargeBy] = useState("weight");
  const [ruleName, setRuleName] = useState("");
  // 多选国家/地区
  const [countriesSelected, setCountriesSelected] = useState([]);
  const [countryInput, setCountryInput] = useState("");

  // 多选辅助方法
  const removeSelected = (val) =>
    setCountriesSelected((prev) => prev.filter((v) => v !== val));
  const selectAllCountries = () =>
    setCountriesSelected((Array.isArray(countries) ? countries : []).map((c) => c.value));
  const clearCountries = () => setCountriesSelected([]);

  // 简单模糊匹配：大小写不敏感+去重音+分词（包含全部词）
  const normalize = (s) => (s || "").toString().normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const matchCountry = (item, query) => {
    const q = normalize(query).trim();
    if (!q) return true;
    const parts = q.split(/\s+/).filter(Boolean);
    const hay = `${normalize(item.label)} ${normalize(item.value)}`;
    return parts.every((p) => hay.includes(p));
  };

  // 导出：仅在有 ruleId 的详情页可用
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const fileInputRef = useRef(null);
  const [notice, setNotice] = useState({ active: false, message: "", tone: "success" });
  const showNotice = (message, tone = "success") => setNotice({ active: true, message, tone });

  const onImportClick = () => {
    if (!ruleId) {
      showNotice("请先保存规则以生成 ID，再使用导入", "critical");
      return;
    }
    fileInputRef.current?.click();
  };

  const onFileChange = async (e) => {
    const file = e?.target?.files?.[0];
    if (!file || !ruleId) return;
    try {
      setImporting(true);
      const form = new FormData();
      form.append("file", file);
      const resp = await fetch(`/api/shipping/import/${encodeURIComponent(ruleId)}`, {
        method: "POST",
        body: form,
      });
      if (!resp.ok) {
        const t = await resp.text();
        throw new Error(t || `导入失败(${resp.status})`);
      }
      const data = await resp.json();
      const rule = data?.rule || {};
      // 按要求：规则名称不变，仅按文件更新其他字段
      if (typeof rule.chargeBy === "string") setChargeBy(rule.chargeBy);
      if (Array.isArray(rule.countries)) setCountriesSelected(rule.countries);
      if (Array.isArray(rule.ranges)) {
        setRanges(
          rule.ranges.map((r) => ({
            from: r?.fromVal ?? r?.from ?? "",
            to: r?.toVal ?? r?.to ?? "",
            unit: r?.unit ?? (rule.chargeBy === "volume" ? "CBM" : rule.chargeBy === "quantity" ? "件" : "KG"),
            pricePer: r?.pricePer ?? "",
            fee: r?.fee ?? "",
            feeUnit: r?.feeUnit ?? "CNY",
          }))
        );
      }
      // 清空文件选择，避免同名文件无法再次选择
      if (fileInputRef.current) fileInputRef.current.value = "";
      showNotice("导入成功：已更新表单，尚未保存", "success");
    } catch (err) {
      console.error("导入失败", err);
      showNotice("导入失败，请检查文件格式并重试", "critical");
    } finally {
      setImporting(false);
    }
  };
  const exportRule = async () => {
    if (!ruleId) return;
    try {
      setExporting(true);
      const resp = await fetch(`/api/shipping/export/${encodeURIComponent(ruleId)}`);
      if (!resp.ok) {
        const t = await resp.text();
        throw new Error(t || `导出失败(${resp.status})`);
      }
      const blob = await resp.blob();
      // 从响应头获取文件名
      const cd = resp.headers.get("Content-Disposition") || "";
      let fileName = "shipping-rule.csv";
      const match = cd.match(/filename\*=UTF-8''([^;]+)|filename="?([^";]+)"?/i);
      if (match) {
        fileName = decodeURIComponent(match[1] || match[2] || fileName);
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error("导出失败", e);
      showNotice("导出失败，请稍后重试", "critical");
    } finally {
      setExporting(false);
    }
  };

  const [ranges, setRanges] = useState([]);

  // 初次进入时，如有草稿则预填表单
  useEffect(() => {
    if (!draft) return;
    if (typeof draft.id === "string") setRuleId(draft.id);
    if (typeof draft.ruleName === "string") setRuleName(draft.ruleName);
    if (typeof draft.chargeBy === "string") setChargeBy(draft.chargeBy);
    if (Array.isArray(draft.countriesSelected)) setCountriesSelected(draft.countriesSelected);
    if (Array.isArray(draft.ranges) && draft.ranges.length) {
      setRanges(
        draft.ranges.map((r) => ({
          from: r?.from ?? "",
          to: r?.to ?? "",
          unit: r?.unit ?? (draft.chargeBy === "volume" ? "CBM" : draft.chargeBy === "quantity" ? "件" : "KG"),
          pricePer: r?.pricePer ?? "",
          fee: r?.fee ?? "",
          feeUnit: r?.feeUnit ?? "CNY",
        }))
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 动态派生：重量/体积/件数（需在依赖这些值的函数之前声明）
  const isWeight = chargeBy === "weight";
  const isVolume = chargeBy === "volume";
  const isQuantity = chargeBy === "quantity";
  const rangeLabel = isWeight ? "重量范围" : isVolume ? "体积范围" : "件数范围";
  const unitOptions = isWeight
    ? [{ label: "KG", value: "KG" }]
    : isVolume
    ? [{ label: "CBM", value: "CBM" }]
    : [{ label: "件", value: "件" }];
  const priceUnit = isWeight ? "KG" : isVolume ? "CBM" : "件";

  // 区间校验错误（例如：范围止 < 范围起）
  const [rangeErrors, setRangeErrors] = useState([]);

  // 输入清洗与限制
  const handleRangeChange = (idx, key, raw) => {
    let v = raw ?? "";
    if (isQuantity) {
      // 仅允许数字，正整数；允许空字符串以便输入进行中
      v = String(v).replace(/[^0-9]/g, "");
      // 去掉前导0，但保留单个0在输入进行中（随后会被 min=1 阻止提交）
      if (v.length > 1) {
        v = v.replace(/^0+/, "");
      }
    } else {
      // 非负数，允许小数
      v = String(v)
        .replace(/[^0-9.]/g, "") // 仅保留数字和小数点
        .replace(/(\..*)\./g, "$1"); // 只保留第一个小数点
      // 形如 .5 -> 0.5（体验更好）
      if (v.startsWith(".")) v = `0${v}`;
    }
    updateRange(idx, key, v);
  };

  // 根据当前计费方式将字符串解析为可比较的数值
  const parseValue = useCallback(
    (s) => {
      if (s === "" || s === null || s === undefined) return null;
      return isQuantity
        ? Number.isNaN(parseInt(s, 10))
          ? null
          : parseInt(s, 10)
        : Number.isNaN(parseFloat(s))
        ? null
        : parseFloat(s);
    },
    [isQuantity]
  );

  // 计算区间错误：范围止必须 >= 范围起
  useEffect(() => {
    const errs = (Array.isArray(ranges) ? ranges : []).map((r) => {
      const a = parseValue(r.from);
      const b = parseValue(r.to);
      let toError;
      if (a !== null && b !== null && b < a) {
        toError = "范围止必须≥范围起";
      }
      return { toError };
    });
    setRangeErrors(errs);
  }, [ranges, parseValue]);

  // 上文已声明（此处删除重复定义）

  const addRange = () =>
    setRanges((r) => [
      ...r,
      {
        from: "",
        to: "",
        unit: isWeight ? "KG" : isVolume ? "CBM" : "件",
        pricePer: "",
        fee: "",
        feeUnit: "CNY",
      },
    ]);
  const removeRange = (idx) =>
    setRanges((r) => (Array.isArray(r) && r.length > 1 ? r.filter((_, i) => i !== idx) : r));
  const updateRange = (idx, key, value) =>
    setRanges((r) => r.map((it, i) => (i === idx ? { ...it, [key]: value } : it)));

  // 当切换计费方式时，统一已有区间的单位
  useEffect(() => {
    const newUnit = isWeight ? "KG" : isVolume ? "CBM" : "件";
    setRanges((r) => r.map((it) => ({ ...it, unit: newUnit })));
  }, [isWeight, isVolume, isQuantity]);

  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (!ruleName || !Array.isArray(ranges) || ranges.length === 0) return;
    try {
      setSaving(true);
      const payload = {
        ...(ruleId ? { id: ruleId } : {}),
        name: ruleName,
        chargeBy,
        countries: countriesSelected,
        description: null,
        ranges: (ranges || []).map((r) => ({
          from: r.from,
          to: r.to,
          unit: r.unit,
          pricePer: r.pricePer,
          fee: r.fee,
          feeUnit: r.feeUnit || "CNY",
        })),
      };
      const resp = await fetch("/api/shipping/rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!resp.ok) {
        const t = await resp.text();
        throw new Error(t || `保存失败(${resp.status})`);
      }
      // 保存成功后返回列表页
      navigate("/app");
    } catch (e) {
      console.error("保存运费规则失败", e);
      showNotice("保存失败，请重试", "critical");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Page>
      <TitleBar title={ruleId ? "编辑运费规则" : "添加运费规则"} />
      <BlockStack gap="500">
        {notice.active ? (
          <Banner tone={notice.tone} onDismiss={() => setNotice((n) => ({ ...n, active: false }))}>
            {notice.message}
          </Banner>
        ) : null}
        <InlineGrid columns={["280px", "1fr"]} gap="300">
          {/* 左侧：目的地 */}
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between">
                <Text as="h2" variant="headingMd">目的地</Text>
                {ruleId ? (
                  <ButtonGroup>
                    <Button onClick={onImportClick} loading={importing}>导入</Button>
                    <Button onClick={exportRule} loading={exporting}>导出</Button>
                  </ButtonGroup>
                ) : null}
              </InlineStack>
              {/* 隐藏的文件输入用于触发导入 */}
              <input
                ref={fileInputRef}
                onChange={onFileChange}
                type="file"
                accept=".xls,application/vnd.ms-excel,application/xml,.xml"
                style={{ position: "absolute", left: "-9999px", width: 1, height: 1, opacity: 0 }}
              />
              <BlockStack gap="200">
                <Text as="span" variant="bodySm">国家/地区</Text>
                <InlineStack align="space-between">
                  <ButtonGroup>
                    <Button onClick={selectAllCountries}>全选</Button>
                    <Button onClick={clearCountries}>清空</Button>
                  </ButtonGroup>
                    <Text as="span" variant="bodySm">已选 {countriesSelected.length} 个</Text>
                </InlineStack>
                <Autocomplete
                  allowMultiple
                  options={
                    (Array.isArray(countries) ? countries : []).filter((o) => matchCountry(o, countryInput))
                  }
                  selected={countriesSelected}
                  onSelect={setCountriesSelected}
                  listTitle="国家/地区"
                  textField={
                    <Autocomplete.TextField
                      label="国家/地区"
                      labelHidden
                      value={countryInput}
                      onChange={setCountryInput}
                      placeholder={countriesSelected.length ? "" : "搜索并选择一个或多个国家"}
                      autoComplete="off"
                      prefix={
                        countriesSelected.length ? (
                          <InlineStack gap="100" align="start">
                            {(() => {
                              const selectedObjs = (Array.isArray(countries) ? countries : []).filter((c) =>
                                countriesSelected.includes(c.value)
                              );
                              const head = selectedObjs.slice(0, 2);
                              const rest = selectedObjs.length - head.length;
                              return (
                                <>
                                  {head.map((c) => (
                                    <Tag key={`infield-${c.value}`} onRemove={() => removeSelected(c.value)}>
                                      {c.label}
                                    </Tag>
                                  ))}
                                  {rest > 0 ? <Tag>+{rest}</Tag> : null}
                                </>
                              );
                            })()}
                          </InlineStack>
                        ) : undefined
                      }
                    />
                  }
                />
              </BlockStack>
            </BlockStack>
          </Card>

          {/* 右侧：运费计算规则 */}
          <Card>
            <BlockStack gap="500">
              {/* 规则名称 */}
              <BlockStack gap="200">
                <Text as="span" variant="bodySm">规则名称</Text>
                <TextField
                  label="规则名称"
                  labelHidden
                  value={ruleName}
                  onChange={setRuleName}
                  autoComplete="off"
                  placeholder="请输入规则名称"
                />
              </BlockStack>
              <InlineStack gap="400">
                {/* <BlockStack gap="200">
                  <Text as="span" variant="bodySm">运费计算方式</Text>
                  <Select
                    options={[
                      { label: "自定义运费", value: "custom" },
                      { label: "固定运费", value: "fixed" },
                    ]}
                    value={calcType}
                    onChange={setCalcType}
                  />
                </BlockStack> */}
                <BlockStack gap="200">
                  <Text as="span" variant="bodySm">自定义计费方式</Text>
                  <Select
                    options={[
                      { label: "按重量计费", value: "weight" },
                      { label: "按体积计费", value: "volume" },
                      { label: "按件计费", value: "quantity" },
                    ]}
                    value={chargeBy}
                    onChange={setChargeBy}
                  />
                </BlockStack>
              </InlineStack>

              <Divider />

              <BlockStack gap="400">
                {ranges.map((rng, idx) => (
                  <Box key={idx} padding="300" borderWidth="025" borderColor="border" borderRadius="200">
                    <BlockStack gap="300">
                      <InlineStack gap="300">
                        <BlockStack gap="100">
                          <Text tone="critical" as="span" variant="bodySm">{rangeLabel}</Text>
                          <InlineStack gap="200">
                            <TextField
                              label="范围起"
                              labelHidden
                              value={rng.from}
                              onChange={(v) => handleRangeChange(idx, "from", v)}
                              autoComplete="off"
                              type="number"
                              min={isQuantity ? 1 : 0}
                              step={isQuantity ? 1 : "any"}
                            />
                            <Select
                              label="单位"
                              labelHidden
                              options={unitOptions}
                              value={rng.unit}
                              onChange={(v) => updateRange(idx, "unit", v)}
                            />
                            <TextField
                              label="范围止"
                              labelHidden
                              value={rng.to}
                              onChange={(v) => handleRangeChange(idx, "to", v)}
                              autoComplete="off"
                              type="number"
                              min={isQuantity ? 1 : 0}
                              step={isQuantity ? 1 : "any"}
                              error={rangeErrors?.[idx]?.toError}
                            />
                            <Select
                              label="单位"
                              labelHidden
                              options={unitOptions}
                              value={rng.unit}
                              onChange={(v) => updateRange(idx, "unit", v)}
                            />
                          </InlineStack>
                        </BlockStack>
                      </InlineStack>

                      <InlineStack gap="300">
                        <BlockStack gap="100">
                          <Text tone="critical" as="span" variant="bodySm">{`运费(RMB/${priceUnit})`}</Text>
                          <TextField
                            label="运费"
                            labelHidden
                            value={rng.pricePer}
                            onChange={(v) => updateRange(idx, "pricePer", v)}
                            autoComplete="off"
                          />
                        </BlockStack>
                        <BlockStack gap="100">
                          <Text tone="critical" as="span" variant="bodySm">挂号费(RMB/票)</Text>
                          <InlineStack gap="200">
                            <Select
                              label="币种"
                              labelHidden
                              options={[{ label: "CNY", value: "CNY" }]}
                              value={rng.feeUnit}
                              onChange={(v) => updateRange(idx, "feeUnit", v)}
                            />
                            <TextField
                              label="挂号费"
                              labelHidden
                              value={rng.fee}
                              onChange={(v) => updateRange(idx, "fee", v)}
                              autoComplete="off"
                            />
                          </InlineStack>
                        </BlockStack>
                      </InlineStack>
                      <InlineStack align="end">
                        <Button tone="critical" onClick={() => removeRange(idx)} disabled={ranges.length === 1}>
                          删除
                        </Button>
                      </InlineStack>
                    </BlockStack>
                  </Box>
                ))}
                <Button variant="plain" onClick={addRange}>{isWeight ? "增加续重范围" : isVolume ? "增加体积范围" : "增加件数范围"}</Button>
              </BlockStack>

              <InlineStack gap="300" align="end">
                <Button url="/app" disabled={saving}>取消</Button>
                <Button
                  variant="primary"
                  onClick={save}
                  loading={saving}
                  disabled={saving || (rangeErrors || []).some((e) => e && e.toError)}
                >
                  保存
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </InlineGrid>
      </BlockStack>
    </Page>
  );
}
