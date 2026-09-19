/** Display names are canonical English labels, not runtime authority or model choices. */
export type ConsultantRole = Readonly<{ agentId: string; role: string; emoji: string; legacyLabels: readonly string[] }>;

export const CONSULTANT_ROLES: readonly ConsultantRole[] = Object.freeze([
  ["head", "Head Consultant", "🧭", "Головний консультант"],
  ["critic", "Critic", "🔎", "Критик"],
  ["strategy", "Strategy Consultant", "♟️", "Консультант зі стратегії"],
  ["finance", "Financial Consultant", "📊", "Фінансовий консультант"],
  ["operations", "Operations Consultant", "⚙️", "Консультант з операційної діяльності"],
  ["entrepreneurship", "Entrepreneurship / Business Model Consultant", "🚀", "Консультант із підприємництва та бізнес-моделі"],
  ["b2b-sales", "B2B Sales Consultant", "🤝", "Консультант із B2B-продажів"],
  ["b2c-sales", "B2C Sales Consultant", "🛍️", "Консультант із B2C-продажів"],
  ["marketing", "Marketing / Growth Consultant", "📣", "Консультант із маркетингу та зростання"],
  ["product", "Product / Customer Experience Consultant", "🧩", "Консультант із продукту та клієнтського досвіду"],
  ["leadership", "Organisation / Leadership Consultant", "👥", "Консультант з організації та лідерства"],
  ["data", "Data Analyst", "📈", "Аналітик даних"],
  ["risk", "Risk Consultant", "🛡️", "Консультант із ризиків"],
  ["personal-growth", "Personal Coach / Growth Consultant", "🌱"],
  ["fitness", "Fitness Coach", "💪"],
  ["longevity", "Longevity Coach", "🌿"],
  ["personal-wealth", "Personal Wealth Coach", "💰"],
  ["relationship", "Relationship Coach", "💞"],
  ["psychology", "Psychologist", "🧠"],
  ["psychotherapy", "Psychotherapist", "🛋️"]
].map(([agentId, role, emoji, ...legacyLabels]) => Object.freeze({ agentId: agentId!, role: role!, emoji: emoji!, legacyLabels: Object.freeze(legacyLabels) })));

export const HEAD_CONSULTANT = CONSULTANT_ROLES[0]!;
export const CRITIC_CONSULTANT = CONSULTANT_ROLES[1]!;
export const CONSULTATION_SPECIALISTS = Object.freeze(CONSULTANT_ROLES.slice(2));

export type SpecialistAssignment = Readonly<{
  agentId: string;
  question: string;
  expectedOutcome: string;
  facts: readonly string[];
  constraints: readonly string[];
  /** Other selected specialist IDs; coordinate later, never leak first-pass answers. */
  dependencies: readonly string[];
}>;

export const CONSULTANT_COLOUR_SLOTS = Object.freeze(["#075985", "#7e22ce", "#166534", "#9a3412", "#9f1239", "#3730a3", "#3f6212"]);

/** Caller persists the returned map with the roster; recovery must reuse it. */
export function assignConsultantColourSlots(roster: readonly Readonly<{ agentId: string }>[]): Readonly<Record<string, number>> {
  if (roster.length > CONSULTANT_COLOUR_SLOTS.length || new Set(roster.map(role => role.agentId)).size !== roster.length ||
    roster.some(role => !CONSULTANT_ROLES.some(known => known.agentId === role.agentId))) throw new Error("invalid_consultant_roster");
  return Object.freeze(Object.fromEntries(roster.map((role, slot) => [role.agentId, slot])));
}

export function resolveConsultantRole(labelOrId: string): ConsultantRole | undefined {
  return CONSULTANT_ROLES.find(role => role.agentId === labelOrId || role.role === labelOrId || role.legacyLabels.includes(labelOrId));
}

export const PERSONAL_SPECIALIST_SAFETY_PROMPT = [
  "Every named consultant is an AI role, not a human, licensed clinician, therapist or investment adviser.",
  "Personal specialists provide general educational/coaching support only: no diagnosis, treatment or medication prescription, clinical psychotherapy, guaranteed returns or claimed professional licence.",
  "Do not solicit medical records, government identifiers, banking credentials or secrets. Minimise personal details and never repeat prohibited data in assignments or outputs.",
  "Obtain consent before personal questions about fears, trauma, beliefs or internal conflicts. An ordinary practical request is not consent for intrusive exploration.",
  "When current self-harm risk, danger, abuse or a mental-health crisis needs human help, stop the ordinary consultation/consensus flow. Give a brief compassionate safety handoff in the user's language to local emergency or qualified human support as appropriate; do not claim to have contacted anyone.",
  "For consequential health, psychotherapy or investment decisions, explain limits and recommend qualified human review. A consensus among AI roles does not establish medical safety or factual truth."
].join("\n");
