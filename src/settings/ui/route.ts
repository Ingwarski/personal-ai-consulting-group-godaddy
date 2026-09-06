import type { OwnerSettingsService } from "../owner-settings-do.ts";
import type { CapabilityReceipt } from "../types.ts";
import { renderAccessDeniedDocument, renderSettingsDocument } from "./template.ts";
import { securityHeaders } from "../../http/security-headers.ts";

export type SettingsPageDependencies = Readonly<{
  ownerSettings: OwnerSettingsService;
  getCapabilityReceipt: () => CapabilityReceipt;
  issueCsrfToken: () => Promise<string>;
  now: () => Date;
  hasVerifiedAccess: (request: Request) => boolean;
  ownerActionTokens?: Readonly<Record<string, string>>;
  ownerAuthScriptPath?: string;
}>;

const html = (body: string, status: number): Response =>
  new Response(body, {
    status,
    headers: securityHeaders({ "content-type": "text/html; charset=utf-8" })
  });

export async function handleSettingsPage(
  request: Request,
  dependencies: SettingsPageDependencies
): Promise<Response> {
  if (!dependencies.hasVerifiedAccess(request)) {
    return html(renderAccessDeniedDocument(), 403);
  }

  const read = await dependencies.ownerSettings.read();
  if (read === undefined) {
    return html(
      "<!doctype html><html lang=\"uk\"><title>Налаштування тимчасово недоступні</title><p>Налаштування тимчасово недоступні.</p></html>",
      503
    );
  }

  return html(
    renderSettingsDocument({
      read,
      capabilityReceipt: dependencies.getCapabilityReceipt(),
      csrfToken: await dependencies.issueCsrfToken(),
      now: dependencies.now(),
      ...(dependencies.ownerActionTokens === undefined ? {} : { ownerActionTokens: dependencies.ownerActionTokens }),
      ...(dependencies.ownerAuthScriptPath === undefined ? {} : { ownerAuthScriptPath: dependencies.ownerAuthScriptPath })
    }),
    200
  );
}
