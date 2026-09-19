export const SUBSCRIPTION_PROVIDERS = ["ChatGPT/Codex", "Claude Code"] as const;
export const USAGE_PROVIDERS = ["Codex", "Claude Code"] as const;

type SubscriptionProvider = (typeof SUBSCRIPTION_PROVIDERS)[number];
type UsageProvider = (typeof USAGE_PROVIDERS)[number];
type UnknownRecord = Record<string, unknown>;

export type SubscriptionFee =
  | Readonly<{ provider: SubscriptionProvider; status: "configured"; monthlyAmount: number; currency: string; source: "owner_configured" }>
  | Readonly<{ provider: SubscriptionProvider; status: "unknown" }>;

export type InfrastructureSpend = Readonly<{
  service: string;
  period: string;
  amount: number;
  currency: string;
  source: string;
}>;

export type ProviderUsageStatus = Readonly<{
  provider: UsageProvider;
  status: "available" | "unavailable" | "quota_reached";
  reportedAt: string;
  usage?: string;
  limit?: string;
  resetAt?: string;
}>;

export type CostReport = Readonly<{
  reportedAt: string;
  subscriptions: readonly SubscriptionFee[];
  infrastructure: readonly InfrastructureSpend[];
  providerUsage: readonly ProviderUsageStatus[];
  aiSessionMarginalCost: "included_in_subscription_not_attributable";
}>;

export type CostReportResult =
  | Readonly<{ ok: true; value: CostReport }>
  | Readonly<{ ok: false; code: "invalid_cost_report" | "forbidden_session_cost" }>;

const isRecord = (value: unknown): value is UnknownRecord => value !== null && typeof value === "object" && !Array.isArray(value);
const isFiniteNonNegative = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const nonEmpty = (value: unknown, maximum = 180): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= maximum;
const isCurrency = (value: unknown): value is string => typeof value === "string" && /^[A-Z]{3}$/.test(value);
const isPeriod = (value: unknown): value is string => typeof value === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
const isTimestamp = (value: unknown): value is string => typeof value === "string" && !Number.isNaN(Date.parse(value));

const hasOnly = (value: UnknownRecord, allowed: readonly string[]): boolean =>
  Object.keys(value).every((key) => allowed.includes(key));

function forbiddenSessionCost(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(forbiddenSessionCost);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, entry]) =>
    /per.?session|token.?cost|marginal.?cost|usage.?credit|extra.?usage/i.test(key) || forbiddenSessionCost(entry)
  );
}

function parseSubscription(value: unknown): SubscriptionFee | undefined {
  if (!isRecord(value) || !SUBSCRIPTION_PROVIDERS.includes(value.provider as SubscriptionProvider) || !nonEmpty(value.provider)) return undefined;
  if (value.status === "unknown" && hasOnly(value, ["provider", "status"])) {
    return Object.freeze({ provider: value.provider as SubscriptionProvider, status: "unknown" as const });
  }
  if (value.status === "configured" && hasOnly(value, ["provider", "status", "monthlyAmount", "currency", "source"]) &&
    isFiniteNonNegative(value.monthlyAmount) && isCurrency(value.currency) && value.source === "owner_configured") {
    return Object.freeze({
      provider: value.provider as SubscriptionProvider,
      status: "configured" as const,
      monthlyAmount: value.monthlyAmount,
      currency: value.currency,
      source: "owner_configured" as const
    });
  }
  return undefined;
}

function parseInfrastructure(value: unknown): InfrastructureSpend | undefined {
  if (!isRecord(value) || !hasOnly(value, ["service", "period", "amount", "currency", "source"]) ||
    !nonEmpty(value.service) || !isPeriod(value.period) || !isFiniteNonNegative(value.amount) || !isCurrency(value.currency) || !nonEmpty(value.source, 360)) {
    return undefined;
  }
  return Object.freeze({ service: value.service, period: value.period, amount: value.amount, currency: value.currency, source: value.source });
}

function parseUsage(value: unknown): ProviderUsageStatus | undefined {
  if (!isRecord(value) || !USAGE_PROVIDERS.includes(value.provider as UsageProvider) || !nonEmpty(value.provider) ||
    !["available", "unavailable", "quota_reached"].includes(value.status as string) || !isTimestamp(value.reportedAt) ||
    !hasOnly(value, ["provider", "status", "reportedAt", "usage", "limit", "resetAt"])) return undefined;
  if ((value.usage !== undefined && !nonEmpty(value.usage, 240)) || (value.limit !== undefined && !nonEmpty(value.limit, 240)) ||
    (value.resetAt !== undefined && !isTimestamp(value.resetAt))) return undefined;
  return Object.freeze({
    provider: value.provider as UsageProvider,
    status: value.status as ProviderUsageStatus["status"],
    reportedAt: value.reportedAt,
    ...(value.usage === undefined ? {} : { usage: value.usage as string }),
    ...(value.limit === undefined ? {} : { limit: value.limit as string }),
    ...(value.resetAt === undefined ? {} : { resetAt: value.resetAt as string })
  });
}

/**
 * This parser intentionally has no field for an estimated token/session price.
 * It accepts only owner-configured subscription fees, factual invoices and a
 * provider-reported availability/limit/reset status.
 */
export function parseCostReport(value: unknown): CostReportResult {
  if (forbiddenSessionCost(value)) return { ok: false, code: "forbidden_session_cost" };
  if (!isRecord(value) || !hasOnly(value, ["reportedAt", "subscriptions", "infrastructure", "providerUsage"]) ||
    !isTimestamp(value.reportedAt) || !Array.isArray(value.subscriptions) || !Array.isArray(value.infrastructure) || !Array.isArray(value.providerUsage)) {
    return { ok: false, code: "invalid_cost_report" };
  }
  const subscriptions = value.subscriptions.map(parseSubscription);
  const infrastructure = value.infrastructure.map(parseInfrastructure);
  const providerUsage = value.providerUsage.map(parseUsage);
  if (subscriptions.some((entry) => entry === undefined) || infrastructure.some((entry) => entry === undefined) || providerUsage.some((entry) => entry === undefined)) {
    return { ok: false, code: "invalid_cost_report" };
  }
  const resolvedSubscriptions = subscriptions as SubscriptionFee[];
  const resolvedUsage = providerUsage as ProviderUsageStatus[];
  if (resolvedSubscriptions.length !== SUBSCRIPTION_PROVIDERS.length || resolvedUsage.length !== USAGE_PROVIDERS.length ||
    new Set(resolvedSubscriptions.map((entry) => entry.provider)).size !== SUBSCRIPTION_PROVIDERS.length ||
    new Set(resolvedUsage.map((entry) => entry.provider)).size !== USAGE_PROVIDERS.length) return { ok: false, code: "invalid_cost_report" };
  return Object.freeze({
    ok: true,
    value: Object.freeze({
      reportedAt: value.reportedAt,
      subscriptions: Object.freeze(resolvedSubscriptions),
      infrastructure: Object.freeze(infrastructure as InfrastructureSpend[]),
      providerUsage: Object.freeze(resolvedUsage),
      aiSessionMarginalCost: "included_in_subscription_not_attributable" as const
    })
  });
}

const feeLine = (fee: SubscriptionFee): string => fee.status === "configured"
  ? `- ${fee.provider}: ${fee.monthlyAmount} ${fee.currency}/міс. (налаштовано власником)`
  : `- ${fee.provider}: сума не налаштована — невідомо.`;

const usageLine = (status: ProviderUsageStatus): string => {
  if (status.status === "unavailable") return `- ${status.provider}: дані usage/ліміту/reset недоступні.`;
  const details = [status.usage, status.limit, status.resetAt === undefined ? undefined : `reset: ${status.resetAt}`].filter((entry): entry is string => entry !== undefined);
  return `- ${status.provider}: ${status.status === "quota_reached" ? "ліміт вичерпано" : "дані доступні"}${details.length === 0 ? "." : ` — ${details.join("; ")}.`}`;
};

/** Browser-ready body for the `Витрати` command; it performs no aggregation across currencies. */
export function formatCostReport(report: CostReport): string {
  const infrastructure = report.infrastructure.length === 0
    ? "- Фактичних інфраструктурних платежів ще не зафіксовано."
    : report.infrastructure.map((entry) => `- ${entry.service}: ${entry.amount} ${entry.currency} за ${entry.period} (джерело: ${entry.source}).`).join("\n");
  return [
    "## Витрати",
    "### Підписки",
    report.subscriptions.map(feeLine).join("\n"),
    "### Інфраструктура",
    infrastructure,
    "### Статус провайдерів",
    report.providerUsage.map(usageLine).join("\n"),
    "### AI-використання сесії",
    "Включене в підписку / не розподіляється на окрему сесію. Вигадана ціна токенів за сесію не показується."
  ].join("\n\n");
}
