import { isAgentId } from "../identity/ids.ts";

export type AgentProvider = "codex" | "claude_code";

export type AgentRegistration = Readonly<{
  agentId: string;
  role: string;
  provider: AgentProvider;
  runtimeSessionRef: string;
}>;

export type ConsiliumRosterResult =
  | Readonly<{ ok: true; agents: readonly AgentRegistration[] }>
  | Readonly<{ ok: false; code: "invalid_specialist_count" | "missing_critic" | "duplicate_agent" | "invalid_agent_registration" }>;

export function validateConsiliumRoster(
  specialists: readonly AgentRegistration[],
  critic: AgentRegistration
): ConsiliumRosterResult {
  if (specialists.length < 2 || specialists.length > 5) {
    return { ok: false, code: "invalid_specialist_count" };
  }
  const agents = [...specialists, critic];
  if (critic.provider !== "claude_code" && critic.provider !== "codex") return { ok: false, code: "missing_critic" };
  if (new Set(agents.map((agent) => agent.agentId)).size !== agents.length) {
    return { ok: false, code: "duplicate_agent" };
  }
  if (new Set(agents.map((agent) => `${agent.provider}:${agent.runtimeSessionRef}`)).size !== agents.length ||
    specialists.some((agent) => agent.provider !== "codex")) return { ok: false, code: "invalid_agent_registration" };
  if (agents.some((agent) => !isAgentId(agent.agentId) || agent.role.trim().length === 0 || agent.runtimeSessionRef.trim().length === 0)) {
    return { ok: false, code: "invalid_agent_registration" };
  }
  return { ok: true, agents: Object.freeze(agents.map((agent) => Object.freeze({ ...agent }))) };
}
