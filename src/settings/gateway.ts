import type { CsrfBinding, CsrfTokenService } from "../access/csrf.ts";
import { createSettingsMutationGuard } from "../access/settings-mutation-guard.ts";
import { secureResponse, securityHeaders } from "../http/security-headers.ts";
import { handleSettingsApi } from "./api.ts";
import type { OwnerSettingsService } from "./owner-settings-do.ts";
import type { CapabilityReceipt } from "./types.ts";
import { handleSettingsPage } from "./ui/route.ts";

export type VerifiedSettingsGateway = Readonly<{
  handle: (request: Request) => Promise<Response>;
}>;

const plain = (body: string, status: number): Response =>
  new Response(body, { status, headers: securityHeaders(new Headers({ "content-type": "text/plain; charset=utf-8" })) });

const json = (body: unknown, status: number, headers: HeadersInit = {}): Response => {
  const outputHeaders = new Headers(headers);
  outputHeaders.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), {
    status,
    headers: securityHeaders(outputHeaders)
  });
};

/**
 * The Worker creates this only after a Cloudflare Access assertion is verified.
 * It deliberately receives a principal-shaped CSRF binding rather than any
 * raw JWT or Google identity material.
 */
export function createVerifiedSettingsGateway(input: Readonly<{
  ownerSettings: OwnerSettingsService;
  getCapabilityReceipt: () => CapabilityReceipt;
  csrf: CsrfTokenService;
  csrfBinding: CsrfBinding;
  ownerActionTokens?: Readonly<Record<string, string>>;
  ownerAuthScriptPath?: string;
  now: () => Date;
}>): VerifiedSettingsGateway {
  const ensureInitialized = async (): Promise<boolean> => (await input.ownerSettings.initialize()).ok;
  const mutationGuard = createSettingsMutationGuard({ csrf: input.csrf, binding: input.csrfBinding });
  const issueCsrfToken = () => input.csrf.issue(
    input.csrfBinding,
    new Date(input.now().getTime() + 5 * 60_000)
  );

  return Object.freeze({
    async handle(request: Request): Promise<Response> {
      const pathname = new URL(request.url).pathname;
      if (pathname !== "/settings" && pathname !== "/api/settings" && pathname !== "/api/settings/reset" && pathname !== "/api/settings/csrf") {
        return plain("Not found.", 404);
      }
      if (!await ensureInitialized()) return plain("Settings are temporarily unavailable.", 503);

      if (pathname === "/settings") {
        if (request.method !== "GET") return plain("Method not allowed.", 405);
        const csrfToken = await issueCsrfToken();
        return secureResponse(await handleSettingsPage(request, {
          ownerSettings: input.ownerSettings,
          getCapabilityReceipt: input.getCapabilityReceipt,
          issueCsrfToken: async () => csrfToken,
          now: input.now,
          hasVerifiedAccess: () => true,
          ...(input.ownerActionTokens === undefined ? {} : { ownerActionTokens: input.ownerActionTokens }),
          ...(input.ownerAuthScriptPath === undefined ? {} : { ownerAuthScriptPath: input.ownerAuthScriptPath })
        }));
      }

      if (pathname === "/api/settings/csrf") {
        if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405, { allow: "POST" });
        if (
          request.headers.get("origin") !== input.csrfBinding.origin ||
          request.headers.get("sec-fetch-site") !== "same-origin"
        ) return json({ error: "forbidden" }, 403);
        return json({ csrfToken: await issueCsrfToken() }, 200);
      }

      return secureResponse(await handleSettingsApi(request, input.ownerSettings, {
        allowsMutation: (mutationRequest) => mutationGuard.allows(mutationRequest)
      }));
    }
  });
}
