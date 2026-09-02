export function securityHeaders(headers: HeadersInit = {}): Headers {
  const output = new Headers(headers);
  output.set("cache-control", "no-store");
  output.set("content-security-policy", "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'");
  output.set("permissions-policy", "camera=(), geolocation=(), microphone=()");
  // HTML form navigations serialize Origin as `null` under `no-referrer`.
  // `same-origin` preserves the exact Origin required by the mutation guard
  // without disclosing a Referer to cross-origin destinations.
  output.set("referrer-policy", "same-origin");
  output.set("strict-transport-security", "max-age=31536000; includeSubDomains");
  output.set("x-content-type-options", "nosniff");
  output.set("x-frame-options", "DENY");
  return output;
}

export function secureResponse(response: Response): Response {
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: securityHeaders(response.headers)
  });
}
