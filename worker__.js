const CONFIG = {
  MAX_REDIRECTS: 5,
  TIMEOUT_MS: 20_000,

  // 大きすぎるリクエスト本文を防止
  MAX_REQUEST_BODY_SIZE: 10 * 1024 * 1024,

  CORS_ORIGIN: "*",

  ALLOWED_METHODS: new Set([
    "GET",
    "HEAD",
    "POST",
    "PUT",
    "PATCH",
    "DELETE",
  ]),
};

const FORWARDED_REQUEST_HEADERS = [
  "accept",
  "accept-language",
  "authorization",
  "cookie",
  "content-type",
  "content-language",
  "content-encoding",
  "origin",
  "referer",
  "range",
  "if-range",
  "if-none-match",
  "if-modified-since",
  "if-match",
  "if-unmodified-since",
  "user-agent",
];

const REMOVED_RESPONSE_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

const EXPOSED_RESPONSE_HEADERS = [
  "Content-Type",
  "Content-Length",
  "Content-Range",
  "Accept-Ranges",
  "Content-Disposition",
  "ETag",
  "Last-Modified",
  "Cache-Control",
  "Expires",
  "Location",
  "Date",
  "Allow",
  "X-Proxy-Final-URL",
  "X-Proxy-Redirect-Count",
];

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return handleOptions(request);
    }

    if (!CONFIG.ALLOWED_METHODS.has(request.method)) {
      return jsonResponse(
        {
          error: "Unsupported method",
          method: request.method,
          allowedMethods: [
            ...CONFIG.ALLOWED_METHODS,
            "OPTIONS",
          ],
        },
        405,
        {
          Allow: [
            ...CONFIG.ALLOWED_METHODS,
            "OPTIONS",
          ].join(", "),
        }
      );
    }

    const workerUrl = new URL(request.url);
    let targetUrl;

    if (isGarticPhoneHostname(workerUrl.hostname)) {
      targetUrl = workerUrl;
    } else {
      const targetParam =
        workerUrl.searchParams.get("url");

      if (!targetParam) {
        return jsonResponse(
          {
            error: "Missing url parameter",
            example:
              `${workerUrl.origin}/?url=` +
              encodeURIComponent(
                "https://example.com/api"
              ),
          },
          400
        );
      }

      try {
        targetUrl = new URL(targetParam);
      } catch {
        return jsonResponse(
          {
            error: "Invalid target URL",
          },
          400
        );
      }
    }

    const validation =
      validateTargetUrl(targetUrl);

    if (!validation.ok) {
      return jsonResponse(
        {
          error: validation.error,
        },
        validation.status
      );
    }

    const contentLength = Number(
      request.headers.get("content-length") || 0
    );

    if (
      Number.isFinite(contentLength) &&
      contentLength >
        CONFIG.MAX_REQUEST_BODY_SIZE
    ) {
      return jsonResponse(
        {
          error: "Request body is too large",
          maximumBytes:
            CONFIG.MAX_REQUEST_BODY_SIZE,
        },
        413
      );
    }

    let requestBody = null;

    if (methodCanHaveBody(request.method)) {
      try {
        requestBody =
          await request.arrayBuffer();
      } catch {
        return jsonResponse(
          {
            error:
              "Failed to read request body",
          },
          400
        );
      }

      if (
        requestBody.byteLength >
        CONFIG.MAX_REQUEST_BODY_SIZE
      ) {
        return jsonResponse(
          {
            error: "Request body is too large",
            maximumBytes:
              CONFIG.MAX_REQUEST_BODY_SIZE,
          },
          413
        );
      }
    }

    const controller = new AbortController();

    const timeoutId = setTimeout(() => {
      controller.abort();
    }, CONFIG.TIMEOUT_MS);

    try {
      const result =
        await fetchWithSafeRedirects({
          initialUrl: targetUrl,
          incomingRequest: request,
          initialMethod: request.method,
          initialBody: requestBody,
          signal: controller.signal,
        });

      if (
        result.response.status === 101 &&
        result.response.webSocket
      ) {
        return result.response;
      }

      return createProxyResponse(
        result.response,
        request.method,
        result.finalUrl,
        result.redirectCount
      );
    } catch (error) {
      if (error?.name === "AbortError") {
        return jsonResponse(
          {
            error:
              "Upstream request timed out",
            timeoutMs: CONFIG.TIMEOUT_MS,
          },
          504
        );
      }

      if (error instanceof ProxyError) {
        return jsonResponse(
          {
            error: error.message,
          },
          error.status
        );
      }

      console.error(
        "Proxy request failed:",
        error
      );

      return jsonResponse(
        {
          error:
            "Failed to fetch target URL",
        },
        502
      );
    } finally {
      clearTimeout(timeoutId);
    }
  },
};

function isGarticPhoneHostname(hostname) {
  const host = String(hostname || "").toLowerCase();
  return (
    host === "garticphone.com" ||
    host.endsWith(".garticphone.com")
  );
}

async function fetchWithSafeRedirects({
  initialUrl,
  incomingRequest,
  initialMethod,
  initialBody,
  signal,
}) {
  let currentUrl = new URL(initialUrl);
  let currentMethod = initialMethod;
  let currentBody = initialBody;
  let redirectCount = 0;

  while (true) {
    const validation =
      validateTargetUrl(currentUrl);

    if (!validation.ok) {
      throw new ProxyError(
        validation.error,
        validation.status
      );
    }

    const headers =
      buildUpstreamHeaders(
        incomingRequest,
        currentMethod
      );

    const requestOptions = {
      method: currentMethod,
      headers,
      redirect: "manual",
      signal,
    };

    if (
      methodCanHaveBody(currentMethod) &&
      currentBody !== null
    ) {
      requestOptions.body =
        currentBody.slice(0);
    }

    const upstreamRequest = new Request(
      currentUrl.toString(),
      requestOptions
    );

    const response =
      await fetch(upstreamRequest);

    if (!isRedirectStatus(response.status)) {
      return {
        response,
        finalUrl: currentUrl,
        redirectCount,
      };
    }

    const location =
      response.headers.get("location");

    if (!location) {
      return {
        response,
        finalUrl: currentUrl,
        redirectCount,
      };
    }

    if (
      redirectCount >=
      CONFIG.MAX_REDIRECTS
    ) {
      throw new ProxyError(
        `Too many redirects. Maximum is ${CONFIG.MAX_REDIRECTS}.`,
        508
      );
    }

    let nextUrl;

    try {
      nextUrl = new URL(
        location,
        currentUrl
      );
    } catch {
      throw new ProxyError(
        "Upstream returned an invalid redirect URL",
        502
      );
    }

    const nextValidation =
      validateTargetUrl(nextUrl);

    if (!nextValidation.ok) {
      throw new ProxyError(
        `Unsafe redirect blocked: ${nextValidation.error}`,
        403
      );
    }

    /*
     * 一般的なブラウザのリダイレクト動作に合わせる。
     *
     * 303:
     *   HEAD以外はGETへ変更する。
     *
     * 301・302:
     *   POSTの場合はGETへ変更する。
     *
     * 307・308:
     *   メソッドと本文を維持する。
     */
    if (
      response.status === 303 &&
      currentMethod !== "HEAD"
    ) {
      currentMethod = "GET";
      currentBody = null;
    } else if (
      (response.status === 301 ||
        response.status === 302) &&
      currentMethod === "POST"
    ) {
      currentMethod = "GET";
      currentBody = null;
    }

    currentUrl = nextUrl;
    redirectCount++;
  }
}

function buildUpstreamHeaders(
  request,
  method
) {
  const headers = new Headers();

  for (
    const name of
    FORWARDED_REQUEST_HEADERS
  ) {
    const value =
      request.headers.get(name);

    if (value !== null) {
      headers.set(name, value);
    }
  }

  if (
    request.headers.get("upgrade")?.toLowerCase() ===
    "websocket"
  ) {
    for (const name of [
      "upgrade",
      "sec-websocket-key",
      "sec-websocket-version",
      "sec-websocket-protocol",
      "sec-websocket-extensions",
    ]) {
      const value = request.headers.get(name);
      if (value !== null) {
        headers.set(name, value);
      }
    }
  }

  if (!headers.has("accept")) {
    headers.set("accept", "*/*");
  }

  /*
   * GET・HEADに切り替わった場合、
   * 本文関連ヘッダーは送らない。
   */
  if (!methodCanHaveBody(method)) {
    headers.delete("content-type");
    headers.delete("content-length");
    headers.delete("content-encoding");
    headers.delete("content-language");
  }

  /*
   * 接続先によってはOriginが必要。
   * WorkerのOriginではなく接続先Originを設定する。
   */
  return headers;
}

function createProxyResponse(
  upstreamResponse,
  originalMethod,
  finalUrl,
  redirectCount
) {
  const headers = new Headers(
    upstreamResponse.headers
  );

  for (
    const name of
    REMOVED_RESPONSE_HEADERS
  ) {
    headers.delete(name);
  }

  applyCorsHeaders(headers);

  headers.set(
    "X-Proxy-Final-URL",
    finalUrl.toString()
  );

  headers.set(
    "X-Proxy-Redirect-Count",
    String(redirectCount)
  );

  appendVary(headers, "Origin");

  const body =
    originalMethod === "HEAD"
      ? null
      : upstreamResponse.body;

  return new Response(body, {
    status: upstreamResponse.status,
    statusText:
      upstreamResponse.statusText,
    headers,
  });
}

function handleOptions(request) {
  const requestedHeaders =
    request.headers.get(
      "Access-Control-Request-Headers"
    );

  const headers = new Headers();

  applyCorsHeaders(headers);

  headers.set(
    "Access-Control-Max-Age",
    "86400"
  );

  headers.set(
    "Access-Control-Allow-Headers",
    requestedHeaders ||
      [
        "Content-Type",
        "Content-Language",
        "Range",
        "If-Range",
        "If-None-Match",
        "If-Modified-Since",
      ].join(", ")
  );

  appendVary(
    headers,
    "Access-Control-Request-Headers"
  );

  return new Response(null, {
    status: 204,
    headers,
  });
}

function applyCorsHeaders(headers) {
  headers.set(
    "Access-Control-Allow-Origin",
    CONFIG.CORS_ORIGIN
  );

  headers.set(
    "Access-Control-Allow-Methods",
    [
      ...CONFIG.ALLOWED_METHODS,
      "OPTIONS",
    ].join(", ")
  );

  headers.set(
    "Access-Control-Expose-Headers",
    EXPOSED_RESPONSE_HEADERS.join(", ")
  );
}

function appendVary(headers, value) {
  const current =
    headers.get("Vary");

  if (!current) {
    headers.set("Vary", value);
    return;
  }

  const values = current
    .split(",")
    .map((item) =>
      item.trim().toLowerCase()
    );

  if (
    !values.includes(value.toLowerCase())
  ) {
    headers.set(
      "Vary",
      `${current}, ${value}`
    );
  }
}

function methodCanHaveBody(method) {
  return (
    method !== "GET" &&
    method !== "HEAD"
  );
}

function isRedirectStatus(status) {
  return [
    301,
    302,
    303,
    307,
    308,
  ].includes(status);
}

function validateTargetUrl(url) {
  if (url.protocol !== "https:") {
    return {
      ok: false,
      status: 400,
      error:
        "Only HTTPS URLs are allowed",
    };
  }

  if (url.username || url.password) {
    return {
      ok: false,
      status: 400,
      error:
        "Credentials embedded in URLs are not allowed",
    };
  }

  if (
    url.port &&
    url.port !== "443"
  ) {
    return {
      ok: false,
      status: 400,
      error:
        "Only HTTPS port 443 is allowed",
    };
  }

  if (isBlockedHostname(url.hostname)) {
    return {
      ok: false,
      status: 403,
      error:
        "Private or local destinations are not allowed",
    };
  }

  return {
    ok: true,
  };
}

function isBlockedHostname(hostname) {
  const host = hostname
    .trim()
    .toLowerCase()
    .replace(/\.$/, "");

  if (!host) {
    return true;
  }

  if (
    host === "localhost" ||
    host === "localhost.localdomain" ||
    host === "metadata.google.internal" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".lan")
  ) {
    return true;
  }

  const ip = host
    .replace(/^\[/, "")
    .replace(/\]$/, "");

  return (
    isBlockedIPv4(ip) ||
    isBlockedIPv6(ip)
  );
}

function isBlockedIPv4(host) {
  const match = host.match(
    /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/
  );

  if (!match) {
    return false;
  }

  const values = match
    .slice(1)
    .map(Number);

  if (
    values.some(
      (value) =>
        value < 0 || value > 255
    )
  ) {
    return true;
  }

  const [a, b, c] = values;

  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 &&
      b >= 64 &&
      b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 &&
      b >= 16 &&
      b <= 31) ||
    (a === 192 &&
      b === 0 &&
      c === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 &&
      (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isBlockedIPv6(host) {
  if (!host.includes(":")) {
    return false;
  }

  const value = host.toLowerCase();

  return (
    value === "::" ||
    value === "::1" ||
    value.startsWith("fc") ||
    value.startsWith("fd") ||
    /^fe[89ab]/.test(value) ||
    value.startsWith("ff")
  );
}

function jsonResponse(
  data,
  status = 200,
  extraHeaders = {}
) {
  const headers = new Headers({
    "Content-Type":
      "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...extraHeaders,
  });

  applyCorsHeaders(headers);

  return new Response(
    JSON.stringify(data, null, 2),
    {
      status,
      headers,
    }
  );
}

class ProxyError extends Error {
  constructor(
    message,
    status = 500
  ) {
    super(message);
    this.name = "ProxyError";
    this.status = status;
  }
}
