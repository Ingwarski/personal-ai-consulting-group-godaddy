export type SettingsAccessConfiguration = Readonly<{
  issuer: string;
  audience: string;
  ownerEmail: string;
  settingsOrigin: string;
}>;

export type SettingsAccessConfigurationResult =
  | Readonly<{ ok: true; value: SettingsAccessConfiguration }>
  | Readonly<{ ok: false }>;

const REQUIRED_NAMES = [
  "ACCESS_ISSUER",
  "ACCESS_APPLICATION_AUD",
  "ACCESS_OWNER_EMAIL",
  "SETTINGS_ORIGIN"
] as const;

function readNonEmpty(environment: Record<string, unknown>, name: string): string | undefined {
  const value = environment[name];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isAccessIssuer(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === "" &&
      url.hostname.endsWith(".cloudflareaccess.com");
  } catch {
    return false;
  }
}

function isHttpsOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.pathname === "/" && url.search === "" && url.hash === "";
  } catch {
    return false;
  }
}

function isSafeExactEmail(value: string): boolean {
  return !/\s/.test(value) && value.includes("@") && value.length <= 320;
}

const urlOrigin = (value: string): string => new URL(value).origin;

/**
 * Values here are identifiers, not credentials. They remain out of the repo
 * and are required before any protected route is served.
 */
export function parseSettingsAccessConfiguration(
  environment: Record<string, unknown>
): SettingsAccessConfigurationResult {
  const values = REQUIRED_NAMES.map((name) => readNonEmpty(environment, name));
  if (values.some((value) => value === undefined)) return { ok: false };

  const [issuer, audience, ownerEmail, settingsOrigin] = values as [string, string, string, string];
  if (!isAccessIssuer(issuer) || audience.length > 512 || !isSafeExactEmail(ownerEmail) || !isHttpsOrigin(settingsOrigin)) {
    return { ok: false };
  }

  return {
    ok: true,
    value: Object.freeze({
      issuer: urlOrigin(issuer),
      audience,
      ownerEmail: ownerEmail.normalize("NFC").toLowerCase(),
      settingsOrigin: urlOrigin(settingsOrigin)
    })
  };
}
