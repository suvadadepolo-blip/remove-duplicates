const APEX_HOST = "removeduplicates.org";
const EXCEL_PATH_PATTERN = /^\/excel\/?$/i;
const SHEETJS_VENDOR_PATH = "/vendor/sheetjs-0.20.3/xlsx.mjs";
const HOME_JSON_LD_HASH = [
  "sha256-jjZBhMz8Q4E8hfWG",
  "7E0hEbnLDLVj0sIl/",
  "0UGtkoDBS0="
].join("");
const EXCEL_JSON_LD_HASH = [
  "sha256-PfZLxBN07rDYB332",
  "ZsU2TUVFOuTx4wk/",
  "bTFTvaTkPPU="
].join("");

const ROUTE_ASSETS = new Map([
  ["/", "/index.html"],
  ["/excel", "/excel/index.html"],
  ["/terms", "/terms/index.html"],
  ["/terms/", "/terms/index.html"],
  ["/privacy", "/privacy/index.html"],
  ["/privacy/", "/privacy/index.html"]
]);

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  `script-src 'self' '${HOME_JSON_LD_HASH}' '${EXCEL_JSON_LD_HASH}'`,
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'none'",
  "connect-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "upgrade-insecure-requests"
].join("; ");

function isWorkersDev(hostname) {
  return hostname === "workers.dev" || hostname.endsWith(".workers.dev");
}

function isLoopback(hostname) {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
}

function canonicalTargetFor(url) {
  const target = new URL(url);
  let changed = false;

  if (target.protocol === "http:" && !isLoopback(target.hostname)) {
    target.protocol = "https:";
    changed = true;
  }
  if (target.hostname === `www.${APEX_HOST}`) {
    target.hostname = APEX_HOST;
    changed = true;
  }
  if (EXCEL_PATH_PATTERN.test(target.pathname) && target.pathname !== "/excel") {
    target.pathname = "/excel";
    changed = true;
  }

  return changed ? target : null;
}

function redirectLocationFor(source, target) {
  if (isLoopback(source.hostname) && source.origin === target.origin) {
    return `${target.pathname}${target.search}${target.hash}`;
  }
  return target.toString();
}

function withHeaders(response, { hostname, pathname, method, protocol }) {
  const headers = new Headers(response.headers);
  const contentType = headers.get("content-type") || "";

  headers.set("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  headers.set("Origin-Agent-Cluster", "?1");
  headers.set("Permissions-Policy", "camera=(), geolocation=(), microphone=(), payment=(), usb=()");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");

  if (protocol === "https:") {
    headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }

  if (
    isWorkersDev(hostname) ||
    response.status === 404 ||
    pathname === "/terms" ||
    pathname === "/terms/" ||
    pathname === "/privacy" ||
    pathname === "/privacy/"
  ) {
    headers.set("X-Robots-Tag", "noindex, nofollow");
  }

  if (contentType.includes("text/html")) {
    headers.set("Cache-Control", "public, max-age=0, must-revalidate, no-transform");
  } else if (pathname === SHEETJS_VENDOR_PATH) {
    headers.set("Cache-Control", "public, max-age=31536000, immutable");
  } else if (/\.(?:css|js|mjs|webmanifest)$/.test(pathname)) {
    headers.set("Cache-Control", "public, max-age=0, must-revalidate");
  } else if (/\.(?:svg|png|ico)$/.test(pathname)) {
    headers.set("Cache-Control", "public, max-age=3600, stale-while-revalidate=86400");
  } else if (pathname === "/robots.txt" || pathname === "/sitemap.xml") {
    headers.set("Cache-Control", "public, max-age=3600, must-revalidate");
  }

  return new Response(method === "HEAD" ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function responseForMethodNotAllowed(url, method) {
  return withHeaders(
    new Response("Method Not Allowed", {
      status: 405,
      headers: {
        Allow: "GET, HEAD",
        "Content-Type": "text/plain; charset=utf-8"
      }
    }),
    { hostname: url.hostname, pathname: url.pathname, method, protocol: url.protocol }
  );
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const canonicalTarget = canonicalTargetFor(url);

    if (canonicalTarget) {
      return withHeaders(
        new Response(null, {
          status: 308,
          headers: { Location: redirectLocationFor(url, canonicalTarget) }
        }),
        {
          hostname: url.hostname,
          pathname: url.pathname,
          method: request.method,
          protocol: url.protocol
        }
      );
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return responseForMethodNotAllowed(url, request.method);
    }

    const pathname = url.pathname;
    const assetPath = ROUTE_ASSETS.get(pathname);
    const assetRequest = assetPath
      ? new Request(new URL(assetPath, url), request)
      : request;
    let response = await env.ASSETS.fetch(assetRequest);

    if (response.status === 404 && pathname !== "/404.html") {
      const fallback = await env.ASSETS.fetch(
        new Request(new URL("/404.html", url), request)
      );
      response = new Response(request.method === "HEAD" ? null : fallback.body, {
        status: 404,
        statusText: "Not Found",
        headers: fallback.headers
      });
    }

    return withHeaders(response, {
      hostname: url.hostname,
      pathname,
      method: request.method,
      protocol: url.protocol
    });
  }
};
