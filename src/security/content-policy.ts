const secretLikePatterns = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /(?:OPENAI|ANTHROPIC)_API_KEY\s*=/i,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /(?<![\p{L}\p{N}_])(?:[A-Z][A-Z0-9_]*_)?(?:password|passwd|pwd|client[_ -]?secret|access[_ -]?token|refresh[_ -]?token|oauth[_ -]?token|api[_ -]?key|session[_ -]?(?:key|token)|csrf[_ -]?(?:key|token))["']?\s*[:=]\s*["']?[^\s"',;<>]{1,}/iu,
  /(?<![\p{L}\p{N}_])(?:пароль|секрет(?:ний ключ| клієнта)?|клієнтський секрет|токен(?: доступу| оновлення| авторизації)?|ключ (?:доступу|API))["']?\s*[:=]\s*["']?[^\s"',;<>]{1,}/iu,
  /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{4,2048}\.[A-Za-z0-9_-]{2,8192}\.[A-Za-z0-9_-]{8,2048}(?![A-Za-z0-9_-])/u,
  /(?<![\p{L}\p{N}_])(?:passport(?: number)?|tax[_ -]?id|government[_ -]?id|national[_ -]?id|ssn|social security(?: number)?|паспорт(?:ний номер| номер)?|номер паспорта|РНОКПП|ІПН|ідентифікаційний(?: код| номер)|податковий номер)["']?\s*[:=№]\s*["']?(?:[A-ZА-ЯІЇЄҐ]{1,3}[ -]?)?\d(?:[A-ZА-ЯІЇЄҐ0-9 -]{3,20}\d)/iu,
  /\bIBAN["']?\s*[:=]\s*["']?[A-Z]{2}\d{2}(?:[ -]?[A-Z0-9]){11,30}\b/iu
];

function isPaymentCardNumber(candidate: string): boolean {
  const digits = candidate.replace(/[ -]/gu, "");
  const prefix4 = Number(digits.slice(0, 4));
  const issuerMatches = /^4\d{12}(?:\d{3})?(?:\d{3})?$/u.test(digits) ||
    /^5[1-5]\d{14}$/u.test(digits) || (digits.length === 16 && prefix4 >= 2221 && prefix4 <= 2720) ||
    /^3[47]\d{13}$/u.test(digits) || /^(?:6011\d{12,15}|65\d{14,17}|64[4-9]\d{13,16})$/u.test(digits) ||
    (digits.length >= 16 && digits.length <= 19 && prefix4 >= 3528 && prefix4 <= 3589);
  if (!issuerMatches) return false;
  let checksum = 0;
  for (let index = digits.length - 1, double = false; index >= 0; index -= 1, double = !double) {
    let digit = Number(digits[index]);
    if (double) { digit *= 2; if (digit > 9) digit -= 9; }
    checksum += digit;
  }
  return checksum % 10 === 0;
}

function isChecksumValidIban(candidate: string): boolean {
  const compact = candidate.replace(/[ -]/gu, "").toUpperCase();
  if (compact.length < 15 || compact.length > 34) return false;
  const reordered = compact.slice(4) + compact.slice(0, 4);
  let remainder = 0;
  for (const character of reordered) {
    const decimal = /[A-Z]/u.test(character) ? String(character.charCodeAt(0) - 55) : character;
    for (const digit of decimal) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

/** Conservative negative gate. A false result is not proof that content is public. */
export function containsSecretLikeContent(body: string): boolean {
  if (secretLikePatterns.some(pattern => pattern.test(body))) return true;
  for (const [candidate] of body.matchAll(/(?<!\d)(?<!\d[ -])\d(?:[ -]?\d){12,18}(?![ -]?\d)/gu)) {
    if (isPaymentCardNumber(candidate)) return true;
  }
  for (const [candidate] of body.matchAll(/(?<![A-Z0-9])[A-Z]{2}\d{2}(?:[ -]?[A-Z0-9]){11,30}(?![A-Z0-9])/giu)) {
    let prefix = candidate;
    while (prefix.length >= 15) {
      if (isChecksumValidIban(prefix)) return true;
      const boundary = Math.max(prefix.lastIndexOf(" "), prefix.lastIndexOf("-"));
      if (boundary < 4) break;
      prefix = prefix.slice(0, boundary);
    }
  }
  return false;
}
