import { formatCostReport, type CostReport } from "../costs/cost-report.ts";
import type { EffectiveSessionSnapshot } from "../settings/types.ts";
import { type RegistrarDO, type SessionGeneration } from "./registrar-do.ts";

export type OwnerCommand =
  | Readonly<{ kind: "costs" }>
  | Readonly<{ kind: "stop" }>
  | Readonly<{ kind: "new_task" }>
  | Readonly<{ kind: "ordinary_message"; body: string }>;

export type FreshSessionContext = Readonly<{
  sessionId: string;
  settingsSnapshot: EffectiveSessionSnapshot;
}>;

export interface FreshSessionContextProvider {
  /** The production adapter may return only after a fresh subscription/capability preflight. */
  prepare(): Promise<FreshSessionContext | undefined>;
}

export type OwnerCommandResult =
  | Readonly<{ ok: true; kind: "ordinary_message"; body: string }>
  | Readonly<{ ok: true; kind: "costs"; responseBody: string }>
  | Readonly<{ ok: true; kind: "stop"; responseBody: string; session: SessionGeneration; replayed: boolean }>
  | Readonly<{ ok: true; kind: "new_task"; responseBody: string; session: SessionGeneration; replayed: boolean }>
  | Readonly<{ ok: false; kind: "stop" | "new_task"; responseBody: string; code: "no_active_session" | "new_task_preflight_failed" | "registrar_rejected" }>;

const exactCommand = (value: string): "costs" | "stop" | "new_task" | undefined => {
  const normalized = value.trim().toLocaleLowerCase("uk-UA");
  if (normalized === "витрати") return "costs";
  if (normalized === "стоп") return "stop";
  if (normalized === "нова задача") return "new_task";
  return undefined;
};

/** Only exact stand-alone commands receive control semantics; ordinary text stays task context. */
export function parseOwnerCommand(body: string): OwnerCommand {
  const command = exactCommand(body);
  if (command === undefined) return Object.freeze({ kind: "ordinary_message", body });
  return Object.freeze({ kind: command });
}

export class OwnerCommandService {
  readonly #registrar: RegistrarDO;
  readonly #costReport: () => Promise<CostReport>;
  readonly #freshSession: FreshSessionContextProvider;

  constructor(input: Readonly<{
    registrar: RegistrarDO;
    costReport: () => Promise<CostReport>;
    freshSession: FreshSessionContextProvider;
  }>) {
    this.#registrar = input.registrar;
    this.#costReport = input.costReport;
    this.#freshSession = input.freshSession;
  }

  async handle(body: string): Promise<OwnerCommandResult> {
    const command = parseOwnerCommand(body);
    if (command.kind === "ordinary_message") return { ok: true, kind: command.kind, body: command.body };
    if (command.kind === "costs") return { ok: true, kind: "costs", responseBody: formatCostReport(await this.#costReport()) };
    if (command.kind === "stop") return this.#stop();
    return this.#newTask();
  }

  async #stop(): Promise<OwnerCommandResult> {
    const active = await this.#registrar.getActiveSession();
    if (active === undefined) {
      return { ok: false, kind: "stop", code: "no_active_session", responseBody: "## Стоп\n\nАктивної сесії немає." };
    }
    const stopped = await this.#registrar.stopSession(active.generation);
    if (!stopped.ok) {
      return { ok: false, kind: "stop", code: "registrar_rejected", responseBody: "## Стоп\n\nСесію не вдалося безпечно зупинити. Стан не змінено." };
    }
    return {
      ok: true,
      kind: "stop",
      responseBody: "## Стоп\n\nАктивну сесію зупинено. Нові репліки цієї задачі не публікуватимуться.",
      session: stopped.value,
      replayed: stopped.replayed
    };
  }

  async #newTask(): Promise<OwnerCommandResult> {
    const fresh = await this.#freshSession.prepare();
    if (fresh === undefined) {
      return {
        ok: false,
        kind: "new_task",
        code: "new_task_preflight_failed",
        responseBody: "## Нова задача\n\nНовий контекст не створено: перевірка доступних налаштувань або підписок не пройшла. Поточні дані не змінилися."
      };
    }
    const started = await this.#registrar.startNewTask(fresh);
    if (!started.ok) {
      return {
        ok: false,
        kind: "new_task",
        code: "registrar_rejected",
        responseBody: "## Нова задача\n\nНовий контекст не створено. Поточні дані не змінилися."
      };
    }
    return {
      ok: true,
      kind: "new_task",
      responseBody: "## Нова задача\n\nПопередній контекст закрито. Надішліть нову задачу окремим повідомленням.",
      session: started.value,
      replayed: started.replayed
    };
  }
}
