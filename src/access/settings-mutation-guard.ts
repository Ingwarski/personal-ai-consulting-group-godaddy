import type { CsrfBinding, CsrfTokenService } from "./csrf.ts";

export type SettingsMutationGuard = Readonly<{
  allows: (request: Request) => Promise<boolean>;
}>;

/**
 * A valid Access assertion is checked before this guard is constructed. This
 * guard adds the mutation-specific same-origin and CSRF requirements only.
 */
export function createSettingsMutationGuard(input: Readonly<{
  csrf: CsrfTokenService;
  binding: CsrfBinding;
}>): SettingsMutationGuard {
  return Object.freeze({
    async allows(request: Request): Promise<boolean> {
      if (request.headers.get("origin") !== input.binding.origin) return false;
      if (request.headers.get("sec-fetch-site") !== "same-origin") return false;
      return input.csrf.verify(request.headers.get("x-csrf-token"), input.binding);
    }
  });
}
