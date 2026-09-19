import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { RuntimeCredentialVault } from "../godaddy/runtime-credential-vault.ts";
import { createRuntimeCredentialVault } from "../godaddy/runtime-credential-vault.ts";
import { MySqlKeyValueStorage, type MySqlPool } from "../godaddy/mysql-storage.ts";

export const INSTRUCTION_DOCUMENTS = Object.freeze([
  { id: "agents", filename: "AGENTS.md", title: "Consulting behavior" },
  { id: "consilium", filename: "CONSILIUM.md", title: "Consilium protocol" },
  { id: "consulting-playbook", filename: "CONSULTING_PLAYBOOK.md", title: "Consulting playbook" },
  { id: "working-context", filename: "WORKING_CONTEXT.md", title: "Working context" }
] as const);

export type InstructionDocumentId = (typeof INSTRUCTION_DOCUMENTS)[number]["id"];
export type InstructionDocument = Readonly<{
  id: InstructionDocumentId;
  title: string;
  revision: number;
  markdown: string;
  sha256: string;
  updatedAt: string;
}>;
export type InstructionSnapshot = Readonly<{
  capturedAt: string;
  documents: readonly InstructionDocument[];
}>;

type Metadata = Readonly<{
  version: 1;
  revisions: Readonly<Record<InstructionDocumentId, number>>;
  updatedAt: Readonly<Record<InstructionDocumentId, string>>;
}>;

const MAX_DOCUMENT_BYTES = 64 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const metadataKey = "instruction-documents";
const idSet = new Set<string>(INSTRUCTION_DOCUMENTS.map(document => document.id));
const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const vaultKey = (id: InstructionDocumentId, revision: number): string => `doc-${id}-r${revision}`;

function validMarkdown(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && encoder.encode(value).byteLength <= MAX_DOCUMENT_BYTES &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
}

function parseMetadata(value: unknown): Metadata | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || typeof record.revisions !== "object" || record.revisions === null ||
    typeof record.updatedAt !== "object" || record.updatedAt === null) return undefined;
  const revisions = record.revisions as Record<string, unknown>;
  const updatedAt = record.updatedAt as Record<string, unknown>;
  if (INSTRUCTION_DOCUMENTS.some(({ id }) => !Number.isSafeInteger(revisions[id]) || Number(revisions[id]) < 1 ||
    typeof updatedAt[id] !== "string" || !Number.isFinite(Date.parse(updatedAt[id] as string)))) return undefined;
  return Object.freeze({ version: 1, revisions: Object.freeze({
    agents: Number(revisions.agents), consilium: Number(revisions.consilium),
    "consulting-playbook": Number(revisions["consulting-playbook"]), "working-context": Number(revisions["working-context"])
  }), updatedAt: Object.freeze({
    agents: updatedAt.agents as string, consilium: updatedAt.consilium as string,
    "consulting-playbook": updatedAt["consulting-playbook"] as string, "working-context": updatedAt["working-context"] as string
  }) });
}

async function readVaultText(vault: RuntimeCredentialVault, id: InstructionDocumentId, revision: number): Promise<string | undefined> {
  const bytes = await vault.read(vaultKey(id, revision));
  if (bytes === undefined) return undefined;
  try {
    const markdown = decoder.decode(bytes);
    return validMarkdown(markdown) ? markdown : undefined;
  } catch { return undefined; }
}

export type InstructionDocumentService = Readonly<{
  initialize: () => Promise<void>;
  list: () => Promise<readonly InstructionDocument[]>;
  read: (id: InstructionDocumentId) => Promise<InstructionDocument | undefined>;
  update: (input: Readonly<{ id: InstructionDocumentId; expectedRevision: number; markdown: string }>) => Promise<
    | Readonly<{ ok: true; document: InstructionDocument }>
    | Readonly<{ ok: false; code: "invalid_document" | "revision_conflict" | "storage_unavailable" }>
  >;
  restoreDefault: (input: Readonly<{ id: InstructionDocumentId; expectedRevision: number }>) => ReturnType<InstructionDocumentService["update"]>;
  snapshot: () => Promise<InstructionSnapshot>;
}>;

export function createInstructionDocumentService(input: Readonly<{
  pool: MySqlPool;
  rootSecret: unknown;
  repositoryRoot: string;
  now?: () => Date;
  readDefault?: (filename: string) => Promise<string>;
}>): InstructionDocumentService | undefined {
  // Metadata and ciphertext share one namespace so revision validation, the
  // new ciphertext, and the metadata pointer commit in one database
  // transaction. This prevents two processes from winning different halves of
  // the same update.
  const storage = new MySqlKeyValueStorage({ executor: input.pool, namespace: "instruction-documents-v1" });
  const vault = createRuntimeCredentialVault({ storage, rootSecret: input.rootSecret });
  if (vault === undefined) return undefined;
  const now = input.now ?? (() => new Date());
  const readDefault = input.readDefault ?? ((filename: string) => readFile(resolve(input.repositoryRoot, filename), "utf8"));
  let serial: Promise<unknown> = Promise.resolve();
  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = serial.then(operation, operation);
    serial = result.then(() => undefined, () => undefined);
    return result;
  };

  const ensureInitialized = async (): Promise<void> => {
    const current = parseMetadata(await storage.get(metadataKey));
    if (current !== undefined) return;
    const defaults = await Promise.all(INSTRUCTION_DOCUMENTS.map(async document => {
      const markdown = await readDefault(document.filename);
      if (!validMarkdown(markdown)) throw new Error(`Invalid instruction default: ${document.filename}`);
      return { ...document, markdown };
    }));
    const at = now().toISOString();
    await storage.transaction(async transaction => {
      if (parseMetadata(await transaction.get(metadataKey)) !== undefined) return;
      const transactionVault = createRuntimeCredentialVault({ storage: transaction, rootSecret: input.rootSecret });
      if (transactionVault === undefined) throw new Error("Instruction encryption is unavailable.");
      for (const document of defaults) await transactionVault.write(vaultKey(document.id, 1), encoder.encode(document.markdown));
      await transaction.put<Metadata>(metadataKey, Object.freeze({
        version: 1,
        revisions: Object.freeze({ agents: 1, consilium: 1, "consulting-playbook": 1, "working-context": 1 }),
        updatedAt: Object.freeze({ agents: at, consilium: at, "consulting-playbook": at, "working-context": at })
      }));
    });
  };
  const initialize = (): Promise<void> => serialize(ensureInitialized);

  const read = async (id: InstructionDocumentId): Promise<InstructionDocument | undefined> => {
    if (!idSet.has(id)) return undefined;
    await initialize();
    const current = parseMetadata(await storage.get(metadataKey));
    if (current === undefined) return undefined;
    const revision = current.revisions[id];
    const markdown = await readVaultText(vault, id, revision);
    const definition = INSTRUCTION_DOCUMENTS.find(document => document.id === id);
    return markdown === undefined || definition === undefined ? undefined : Object.freeze({
      id, title: definition.title, revision, markdown, sha256: sha256(markdown), updatedAt: current.updatedAt[id]
    });
  };

  const update: InstructionDocumentService["update"] = inputValue => serialize(async () => {
    if (!idSet.has(inputValue.id) || !Number.isSafeInteger(inputValue.expectedRevision) || inputValue.expectedRevision < 1 || !validMarkdown(inputValue.markdown)) {
      return { ok: false as const, code: "invalid_document" as const };
    }
    await ensureInitialized();
    const nextRevision = inputValue.expectedRevision + 1;
    const at = now().toISOString();
    try {
      return await storage.transaction(async transaction => {
        const current = parseMetadata(await transaction.get(metadataKey));
        if (current === undefined) return { ok: false as const, code: "storage_unavailable" as const };
        if (current.revisions[inputValue.id] !== inputValue.expectedRevision) return { ok: false as const, code: "revision_conflict" as const };
        const transactionVault = createRuntimeCredentialVault({ storage: transaction, rootSecret: input.rootSecret });
        if (transactionVault === undefined) return { ok: false as const, code: "storage_unavailable" as const };
        await transactionVault.write(vaultKey(inputValue.id, nextRevision), encoder.encode(inputValue.markdown));
        const next: Metadata = Object.freeze({ version: 1,
          revisions: Object.freeze({ ...current.revisions, [inputValue.id]: nextRevision }),
          updatedAt: Object.freeze({ ...current.updatedAt, [inputValue.id]: at }) });
        await transaction.put(metadataKey, next);
        const definition = INSTRUCTION_DOCUMENTS.find(document => document.id === inputValue.id)!;
        return { ok: true as const, document: Object.freeze({ id: inputValue.id, title: definition.title,
          revision: nextRevision, markdown: inputValue.markdown, sha256: sha256(inputValue.markdown), updatedAt: at }) };
      });
    } catch { return { ok: false as const, code: "storage_unavailable" as const }; }
  });

  const list = async (): Promise<readonly InstructionDocument[]> => {
    const documents = await Promise.all(INSTRUCTION_DOCUMENTS.map(document => read(document.id)));
    if (documents.some(document => document === undefined)) throw new Error("Instruction documents are unavailable.");
    return Object.freeze(documents as InstructionDocument[]);
  };

  return Object.freeze({
    initialize,
    list,
    read,
    update,
    async restoreDefault({ id, expectedRevision }) {
      if (!idSet.has(id)) return { ok: false as const, code: "invalid_document" as const };
      let markdown: string;
      try { markdown = await readDefault(INSTRUCTION_DOCUMENTS.find(document => document.id === id)!.filename); }
      catch { return { ok: false as const, code: "storage_unavailable" as const }; }
      return update({ id, expectedRevision, markdown });
    },
    async snapshot() {
      const documents = await list();
      return Object.freeze({ capturedAt: now().toISOString(), documents });
    }
  });
}

export function isInstructionDocumentId(value: unknown): value is InstructionDocumentId {
  return typeof value === "string" && idSet.has(value);
}
