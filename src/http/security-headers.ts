export function securityHeaders(headers: HeadersInit = {}): Headers {
  const output = new Headers(headers);
  output.set("cache-control", "no-store");
  output.set("content-security-policy", "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'");
  output.set("permissions-policy", "camera=(), geolocation=(), microphone=()");
  output.set("referrer-policy", "no-referrer");
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
