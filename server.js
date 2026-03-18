import express from "express";
import { JSDOM } from "jsdom";
import { LRUCache } from "lru-cache";
import { execFile } from "child_process";
import { promisify } from "util";
import { writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const execFileAsync = promisify(execFile);

const app = express();
const PORT = process.env.PORT || 3000;
const ORIGINAL_HOST = process.env.ORIGINAL_HOST || "doujindesu.tv";
const SITE_NAME = process.env.SITE_NAME || "Komikindo Mirror";
const SITE_TAGLINE = process.env.SITE_TAGLINE || "Baca Manga dan Doujin Bahasa Indonesia";
const IMAGE_PROXY_PATH = "/image-proxy/";

// curl-impersonate binary path
const CURL_BIN =
  process.env.CURL_IMPERSONATE_PATH || "/usr/local/bin/curl-impersonate-chrome";
const CURL_FALLBACK = "curl"; // fallback ke curl biasa

// Cookie file path (persistent across requests, like botasaurus)
const COOKIE_DIR = join(tmpdir(), "mirror-cookies");
const COOKIE_FILE = join(COOKIE_DIR, "cookies.txt");

if (!existsSync(COOKIE_DIR)) {
  mkdirSync(COOKIE_DIR, { recursive: true });
}

// ============================================================
// LRU Cache
// ============================================================
const pageCache = new LRUCache({
  max: 500,
  ttl: 1000 * 60 * 10,
  allowStale: true,
  updateAgeOnGet: true,
});

const imageCache = new LRUCache({
  max: 200,
  ttl: 1000 * 60 * 60,
  maxSize: 500 * 1024 * 1024,
  sizeCalculation: (value) => value.body.length,
});

// ============================================================
// Parse raw body
// ============================================================
app.use(express.raw({ type: "*/*", limit: "50mb" }));

// ============================================================
// Helpers
// ============================================================
function getOrigin(req) {
  const protocol = req.headers["x-forwarded-proto"] || req.protocol || "https";
  const host = req.headers["x-forwarded-host"] || req.headers["host"];
  return `${protocol}://${host}`;
}

function getMirrorHostname(req) {
  return req.headers["x-forwarded-host"] || req.headers["host"];
}

// ============================================================
// curl-impersonate client (botasaurus approach)
// Impersonates Chrome TLS fingerprint (JA3) + Google Referrer
// ============================================================
let curlBinary = CURL_BIN;
let curlImpersonateAvailable = false;

async function detectCurl() {
  // Try curl-impersonate first
  try {
    await execFileAsync(CURL_BIN, ["--version"], { timeout: 5000 });
    curlBinary = CURL_BIN;
    curlImpersonateAvailable = true;
    console.log(`✅ curl-impersonate found: ${CURL_BIN}`);
    return;
  } catch (_) {}

  // Try curl_chrome116 (alternate name)
  try {
    await execFileAsync("curl_chrome116", ["--version"], { timeout: 5000 });
    curlBinary = "curl_chrome116";
    curlImpersonateAvailable = true;
    console.log("✅ curl-impersonate found: curl_chrome116");
    return;
  } catch (_) {}

  // Fallback to regular curl
  try {
    await execFileAsync("curl", ["--version"], { timeout: 5000 });
    curlBinary = "curl";
    curlImpersonateAvailable = false;
    console.log("⚠️  Using regular curl (no TLS impersonation)");
    return;
  } catch (_) {}

  console.error("❌ No curl binary found!");
}

// Key insight from botasaurus:
// 1. TLS fingerprint must match Chrome (curl-impersonate handles this)
// 2. Google Referrer trick bypasses connection challenges
// 3. Cookie persistence stores cf_clearance
async function curlFetch(url, options = {}) {
  const method = (options.method || "GET").toUpperCase();

  const args = [
    "--silent",
    "--show-error",
    "--compressed",        // auto-decompress gzip/br/deflate responses
    "--max-time", "30",
    "--location",          // follow redirects
    "--max-redirs", "5",
    "-b", COOKIE_FILE,     // read cookies (like botasaurus cookie jar)
    "-c", COOKIE_FILE,     // write cookies (persist cf_clearance)
    "-D", "-",             // dump headers to stdout
  ];

  // If curl-impersonate, it auto-sets Chrome TLS fingerprint
  // If regular curl, we need to add headers manually
  if (!curlImpersonateAvailable) {
    args.push(
      "--http2",
      "--compressed",
      "--tlsv1.2",
      "--ciphers",
      "TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256"
    );
  }

  // Google Referrer trick (from botasaurus) — critical for CF bypass
  const referer = options.referer || "https://www.google.com/";

  // Headers (botasaurus-style: browser-like, correct order)
  const defaultHeaders = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9,id;q=0.8",
    "Accept-Encoding": "gzip, deflate, br",
    "Cache-Control": "max-age=0",
    DNT: "1",
    "Upgrade-Insecure-Requests": "1",
    Referer: referer,
    "sec-ch-ua": '"Chromium";v="131", "Not_A Brand";v="24"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "cross-site",
    "Sec-Fetch-User": "?1",
  };

  const headers = { ...defaultHeaders, ...options.headers };

  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined && value !== null) {
      args.push("-H", `${key}: ${value}`);
    }
  }

  // Method
  if (method !== "GET") {
    args.push("-X", method);
  }

  // Body for POST
  if (options.body && method !== "GET" && method !== "HEAD") {
    if (typeof options.body === "string") {
      args.push("--data-raw", options.body);
    } else if (Buffer.isBuffer(options.body) && options.body.length > 0) {
      args.push("--data-raw", options.body.toString("utf-8"));
    }
  }

  // URL — encode any raw spaces/special chars that curl rejects
  const safeUrl = url.replace(/ /g, "%20").replace(/\(/g, "%28").replace(/\)/g, "%29");
  args.push(safeUrl);

  try {
    const result = await execFileAsync(curlBinary, args, {
      maxBuffer: 100 * 1024 * 1024, // 100MB
      timeout: 35000,
      encoding: "buffer",
    });

    // Parse response: headers are dumped first (separated by \r\n\r\n), then body
    const output = result.stdout;
    return parseRawResponse(output);
  } catch (error) {
    // curl returns non-zero for some HTTP codes, check if we got output
    if (error.stdout && error.stdout.length > 0) {
      return parseRawResponse(error.stdout);
    }
    throw new Error(`curl fetch failed: ${error.message}`);
  }
}

// Parse raw HTTP response (headers + body from curl -D -)
function parseRawResponse(buffer) {
  // Find the boundary between headers and body
  const headerEnd = findHeaderEnd(buffer);

  if (headerEnd === -1) {
    // No headers found, treat everything as body
    return {
      status: 200,
      headers: new Map(),
      body: buffer,
      text: () => buffer.toString("utf-8"),
      ok: true,
      _consumed: false,
    };
  }

  const headerBuf = buffer.slice(0, headerEnd);
  const bodyBuf = buffer.slice(headerEnd + 4); // skip \r\n\r\n

  const headerStr = headerBuf.toString("utf-8");

  // There may be multiple HTTP response headers (due to redirects)
  // Take the last one
  const blocks = headerStr.split(/\r?\nHTTP\//);
  const lastBlock = blocks.length > 1 ? "HTTP/" + blocks[blocks.length - 1] : blocks[0];

  const headerLines = lastBlock.split(/\r?\n/);
  const statusLine = headerLines[0];
  const statusMatch = statusLine.match(/HTTP\/[\d.]+\s+(\d+)/);
  const status = statusMatch ? parseInt(statusMatch[1]) : 200;

  const headers = new Map();
  for (let i = 1; i < headerLines.length; i++) {
    const colonIdx = headerLines[i].indexOf(":");
    if (colonIdx > 0) {
      const key = headerLines[i].slice(0, colonIdx).trim().toLowerCase();
      const value = headerLines[i].slice(colonIdx + 1).trim();
      headers.set(key, value);
    }
  }

  return {
    status,
    headers: {
      get: (key) => headers.get(key.toLowerCase()) || null,
      forEach: (cb) => headers.forEach((v, k) => cb(v, k)),
      raw: () => Object.fromEntries(headers),
    },
    body: bodyBuf,
    text: () => bodyBuf.toString("utf-8"),
    ok: status >= 200 && status < 300,
    _consumed: false,
  };
}

function findHeaderEnd(buffer) {
  // Find the last \r\n\r\n before actual body (handles redirects)
  // With -D - and -L, redirect headers are dumped too:
  //   HTTP/1.1 301...\r\n\r\nHTTP/1.1 200...\r\n\r\n<body>
  // We skip \r\n\r\n boundaries that are followed by another HTTP/ block
  let pos = 0;
  while (pos < buffer.length - 3) {
    if (
      buffer[pos] === 0x0d &&
      buffer[pos + 1] === 0x0a &&
      buffer[pos + 2] === 0x0d &&
      buffer[pos + 3] === 0x0a
    ) {
      const afterPos = pos + 4;
      // Check if what follows is another HTTP response (redirect)
      if (
        afterPos + 5 <= buffer.length &&
        buffer.slice(afterPos, afterPos + 5).toString("ascii") === "HTTP/"
      ) {
        // Skip past this boundary — another header block follows
        pos = afterPos;
        continue;
      }
      return pos;
    }
    pos++;
  }
  return -1;
}

// Detect Cloudflare challenge
function isCloudflareChallenge(text) {
  return (
    text.includes("cf-browser-verification") ||
    text.includes("challenge-platform") ||
    text.includes("Just a moment") ||
    text.includes("Checking if the site connection is secure") ||
    text.includes("cf-turnstile") ||
    text.includes("Attention Required! | Cloudflare")
  );
}

// Proxy fetch with auto-retry on CF challenge
async function proxyFetch(url, options = {}) {
  let response = await curlFetch(url, options);

  // Check if Cloudflare blocked
  if (response.status === 403 || response.status === 503) {
    const text = response.text();
    if (isCloudflareChallenge(text)) {
      console.log(`⚠️  Cloudflare challenge on ${url}, retrying with google referrer...`);

      // Clear cookie file and retry with Google referrer
      try { unlinkSync(COOKIE_FILE); } catch (_) {}

      // Retry - botasaurus approach: first visit google, then target
      response = await curlFetch(url, {
        ...options,
        referer: "https://www.google.com/search?q=" + encodeURIComponent(ORIGINAL_HOST),
      });
    }
  }

  return response;
}

// ============================================================
// Route: robots.txt
// ============================================================
app.get("/robots.txt", (req, res) => {
  const origin = getOrigin(req);
  const robotsTxt = `User-agent: *
Allow: /
Crawl-delay: 2

Sitemap: ${origin}/sitemap-index.xml`;

  res.set({
    "Content-Type": "text/plain",
    "Cache-Control": "public, max-age=86400",
  });
  res.status(200).send(robotsTxt);
});

// ============================================================
// Route: Sitemap Index
// ============================================================
app.get("/sitemap-index.xml", async (req, res) => {
  const origin = getOrigin(req);
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap>
    <loc>${origin}/sitemap-main.xml</loc>
    <lastmod>${new Date().toISOString().split("T")[0]}</lastmod>
  </sitemap>
</sitemapindex>`;
  res.set({ "Content-Type": "application/xml", "Cache-Control": "public, max-age=3600" });
  res.status(200).send(xml);
});

// ============================================================
// Route: Main Sitemap
// ============================================================
app.get("/sitemap-main.xml", async (req, res) => {
  const origin = getOrigin(req);
  try {
    const targetUrl = `https://${ORIGINAL_HOST}/sitemap.xml`;
    const response = await proxyFetch(targetUrl);
    const text = response.text();

    let sitemapContent = text
      .replace(new RegExp(`https?://${ORIGINAL_HOST.replace(/\./g, "\\.")}`, "g"), origin)
      .replace(new RegExp(ORIGINAL_HOST.replace(/\./g, "\\."), "g"), getMirrorHostname(req));

    res.set({ "Content-Type": "application/xml", "Cache-Control": "public, max-age=3600" });
    res.status(200).send(sitemapContent);
  } catch (error) {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${origin}/</loc>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>
</urlset>`;
    res.set({ "Content-Type": "application/xml", "Cache-Control": "public, max-age=3600" });
    res.status(200).send(xml);
  }
});

// ============================================================
// Route: Image Proxy
// ============================================================
app.get(`${IMAGE_PROXY_PATH}*`, async (req, res) => {
  try {
    const imageUrl = decodeURIComponent(
      req.originalUrl.replace(IMAGE_PROXY_PATH, "")
    );

    // Cek image cache
    const cached = imageCache.get(imageUrl);
    if (cached) {
      res.set({
        "Content-Type": cached.contentType,
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=31536000",
        "X-Cache": "HIT",
      });
      return res.status(200).send(cached.body);
    }

    // Determine proper referer based on image domain
    let imageReferer = `https://${ORIGINAL_HOST}/`;
    try {
      const imgHost = new URL(imageUrl).hostname;
      if (imgHost.includes("doujindesu")) {
        imageReferer = `https://${imgHost}/`;
      }
    } catch (_) {}

    const imageResponse = await curlFetch(imageUrl, {
      referer: imageReferer,
      headers: {
        Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        "Sec-Fetch-Dest": "image",
        "Sec-Fetch-Mode": "no-cors",
        "Sec-Fetch-Site": "cross-site",
      },
    });

    if (!imageResponse.ok) {
      return res.status(imageResponse.status).send("Image fetch failed");
    }

    const contentType = imageResponse.headers.get("content-type") || "image/webp";
    const body = imageResponse.body;

    // Cache the image
    imageCache.set(imageUrl, { body, contentType });

    res.set({
      "Content-Type": contentType,
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=31536000",
      "X-Cache": "MISS",
    });
    res.status(200).send(body);
  } catch (error) {
    console.error("Image proxy error:", error.message);
    res.status(500).send("Image proxy error");
  }
});

// ============================================================
// Route: Health check
// ============================================================
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    curlImpersonate: curlImpersonateAvailable,
    curlBinary,
    cache: {
      pages: pageCache.size,
      images: imageCache.size,
    },
  });
});

// ============================================================
// Route: Cache clear (admin)
// ============================================================
app.get("/admin/clear-cache", (req, res) => {
  const key = req.query.key;
  if (key !== (process.env.ADMIN_KEY || "changeme")) {
    return res.status(403).send("Forbidden");
  }
  pageCache.clear();
  imageCache.clear();
  try { unlinkSync(COOKIE_FILE); } catch (_) {}
  res.status(200).json({ message: "Cache and cookies cleared" });
});

// ============================================================
// Route: Chapter AJAX endpoint (load_data images)
// ============================================================
app.post("/themes/ajax/ch.php", async (req, res) => {
  try {
    const postBody = req.body ? req.body.toString("utf-8") : "";
    const targetUrl = `https://${ORIGINAL_HOST}/themes/ajax/ch.php`;

    const response = await curlFetch(targetUrl, {
      method: "POST",
      body: postBody,
      referer: `https://${ORIGINAL_HOST}/`,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "text/html, */*; q=0.01",
        "X-Requested-With": "XMLHttpRequest",
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
        Origin: `https://${ORIGINAL_HOST}`,
      },
    });

    let html = response.text();

    // If CF blocked, return empty (client-side JS will handle fallback)
    if (response.status === 403 || isCloudflareChallenge(html)) {
      return res.status(200).send("");
    }

    // Rewrite image URLs in the AJAX response to use our proxy
    const proxyImageDomains = ["desu.photos", "doujindesu.moe", "doujindesu.tv", "doujindesu.xxx", "cdn.doujindesu.dev", "doujindesu.dev"];
    proxyImageDomains.forEach((domain) => {
      const regex = new RegExp(`(src=["'])\\s*(https?://[^"']*${domain.replace(/\./g, "\\.")}[^"']*)(["'])`, "gi");
      html = html.replace(regex, (match, pre, url, post) => {
        return `${pre}${IMAGE_PROXY_PATH}${encodeURIComponent(url.trim())}${post}`;
      });
    });

    res.set({
      "Content-Type": "text/html; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    });
    res.status(200).send(html);
  } catch (error) {
    console.error("AJAX ch.php error:", error.message);
    res.status(200).send("");
  }
});

// ============================================================
// SEO Content Transformer
// ============================================================
function transformForSEO(document, targetUrl, origin, mirrorHostname, requestPath) {
  const head = document.querySelector("head");

  // ---- 1. REMOVE duplikat indicators ----
  document.querySelectorAll('link[rel="canonical"]').forEach((el) => el.remove());
  document.querySelectorAll('link[rel="alternate"]').forEach((el) => el.remove());
  document.querySelectorAll('meta[name="robots"]').forEach((el) => {
    const content = (el.getAttribute("content") || "").toLowerCase();
    if (content.includes("noindex") || content.includes("nofollow")) el.remove();
  });
  document.querySelectorAll('meta[http-equiv="X-Robots-Tag"]').forEach((el) => el.remove());

  // ---- 2. ADD canonical ke mirror ----
  if (head) {
    const canonical = document.createElement("link");
    canonical.setAttribute("rel", "canonical");
    canonical.setAttribute("href", `${origin}${requestPath}`);
    head.appendChild(canonical);

    const metaRobots = document.createElement("meta");
    metaRobots.setAttribute("name", "robots");
    metaRobots.setAttribute("content", "index, follow, max-image-preview:large, max-snippet:-1");
    head.appendChild(metaRobots);
  }

  // ---- 3. TRANSFORM title ----
  const titleEl = document.querySelector("title");
  if (titleEl) {
    let title = titleEl.textContent || "";
    title = title.replace(/doujindesu/gi, SITE_NAME).replace(/\s*[-|–]\s*$/, "");
    if (!title.includes(SITE_NAME)) title = `${title} - ${SITE_NAME}`;
    titleEl.textContent = title;
  }

  // ---- 4. TRANSFORM meta description ----
  const metaDesc = document.querySelector('meta[name="description"]');
  if (metaDesc) {
    let desc = metaDesc.getAttribute("content") || "";
    desc = desc.replace(/doujindesu/gi, SITE_NAME);
    desc = desc.length > 0 ? `${desc} | Baca di ${SITE_NAME}` : `${SITE_TAGLINE} - ${SITE_NAME}`;
    metaDesc.setAttribute("content", desc);
  } else if (head) {
    const newMeta = document.createElement("meta");
    newMeta.setAttribute("name", "description");
    newMeta.setAttribute("content", `${SITE_TAGLINE} - ${SITE_NAME}`);
    head.appendChild(newMeta);
  }

  // ---- 5. TRANSFORM Open Graph tags ----
  document.querySelectorAll('meta[property^="og:"]').forEach((el) => {
    const prop = el.getAttribute("property");
    const content = el.getAttribute("content") || "";
    if (prop === "og:title") {
      el.setAttribute("content", content.replace(/doujindesu/gi, SITE_NAME) + (content.includes(SITE_NAME) ? "" : ` - ${SITE_NAME}`));
    } else if (prop === "og:description") {
      el.setAttribute("content", content.replace(/doujindesu/gi, SITE_NAME) + ` | ${SITE_NAME}`);
    } else if (prop === "og:site_name") {
      el.setAttribute("content", SITE_NAME);
    } else if (prop === "og:url") {
      el.setAttribute("content", `${origin}${requestPath}`);
    }
  });

  // ---- 6. ADD JSON-LD ----
  if (head) {
    const pageTitle = document.querySelector("title")?.textContent || SITE_NAME;
    const pageDesc = document.querySelector('meta[name="description"]')?.getAttribute("content") || SITE_TAGLINE;
    const jsonLd = {
      "@context": "https://schema.org",
      "@type": "WebPage",
      name: pageTitle,
      description: pageDesc,
      url: `${origin}${requestPath}`,
      isPartOf: { "@type": "WebSite", name: SITE_NAME, url: origin, description: SITE_TAGLINE },
      publisher: { "@type": "Organization", name: SITE_NAME },
      inLanguage: "id-ID",
      dateModified: new Date().toISOString(),
    };
    const script = document.createElement("script");
    script.setAttribute("type", "application/ld+json");
    script.textContent = JSON.stringify(jsonLd);
    head.appendChild(script);
  }

  // ---- 7. ADD breadcrumb ----
  if (head && requestPath !== "/") {
    const parts = requestPath.split("/").filter(Boolean);
    const breadcrumbItems = [{ "@type": "ListItem", position: 1, name: "Beranda", item: origin }];
    let accumulated = "";
    parts.forEach((part, i) => {
      accumulated += `/${part}`;
      breadcrumbItems.push({
        "@type": "ListItem",
        position: i + 2,
        name: decodeURIComponent(part).replace(/-/g, " "),
        item: `${origin}${accumulated}`,
      });
    });
    const bScript = document.createElement("script");
    bScript.setAttribute("type", "application/ld+json");
    bScript.textContent = JSON.stringify({ "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: breadcrumbItems });
    head.appendChild(bScript);
  }

  // ---- 8. REMOVE ads ----
  const adContainer = document.querySelector("div#container");
  if (adContainer) adContainer.remove();
  document.querySelectorAll("div.blox.mlb.kln").forEach((el) => el.remove());
  document.querySelectorAll('div[class=""][style*="z-index: 2147483647"]').forEach((el) => el.remove());
  document.querySelectorAll('script[src*="clickadu"]').forEach((el) => el.remove());
  document.querySelectorAll('script[src*="juicyads"]').forEach((el) => el.remove());
  document.querySelectorAll('script[src*="exoclick"]').forEach((el) => el.remove());
  document.querySelectorAll('script[src*="popunder"]').forEach((el) => el.remove());
  document.querySelectorAll("*[onclick]").forEach((el) => el.removeAttribute("onclick"));

  // ---- 9. Rewrite image URLs ----
  // Proxy images from all doujindesu-related domains to bypass hotlink protection
  const proxyImageDomains = ["desu.photos", "doujindesu.moe", "doujindesu.tv", "doujindesu.xxx", "cdn.doujindesu.dev", "doujindesu.dev"];
  const shouldProxyImg = (url) => proxyImageDomains.some((d) => url && url.includes(d));

  document.querySelectorAll("img").forEach((el) => {
    const src = el.getAttribute("src");
    if (shouldProxyImg(src)) {
      el.setAttribute("src", `${IMAGE_PROXY_PATH}${encodeURIComponent(src)}`);
    }
    const dataSrc = el.getAttribute("data-src");
    if (shouldProxyImg(dataSrc)) {
      el.setAttribute("data-src", `${IMAGE_PROXY_PATH}${encodeURIComponent(dataSrc)}`);
    }
    const lazySrc = el.getAttribute("data-lazy-src");
    if (shouldProxyImg(lazySrc)) {
      el.setAttribute("data-lazy-src", `${IMAGE_PROXY_PATH}${encodeURIComponent(lazySrc)}`);
    }
  });

  // Also proxy background images and other image references
  document.querySelectorAll("[style]").forEach((el) => {
    const style = el.getAttribute("style");
    if (style) {
      const rewritten = style.replace(/url\(['"]?(https?:\/\/[^'"\)]+)['"]?\)/gi, (match, url) => {
        if (shouldProxyImg(url)) {
          return `url('${IMAGE_PROXY_PATH}${encodeURIComponent(url)}')`;
        }
        return match;
      });
      if (rewritten !== style) el.setAttribute("style", rewritten);
    }
  });

  // Proxy source elements (picture/source)
  document.querySelectorAll("source").forEach((el) => {
    const srcset = el.getAttribute("srcset");
    if (shouldProxyImg(srcset)) {
      el.setAttribute("srcset", `${IMAGE_PROXY_PATH}${encodeURIComponent(srcset)}`);
    }
  });

  return document;
}

// ============================================================
// Route: Catch-all proxy
// ============================================================
app.all("*", async (req, res) => {
  try {
    const origin = getOrigin(req);
    const mirrorHostname = getMirrorHostname(req);
    const requestPath = req.originalUrl;

    // Cache check
    const cacheKey = `${req.method}:${requestPath}`;
    if (req.method === "GET") {
      const cached = pageCache.get(cacheKey);
      if (cached) {
        res.set(cached.headers);
        res.set("X-Cache", "HIT");
        return res.status(cached.status).send(cached.body);
      }
    }

    const targetUrl = `https://${ORIGINAL_HOST}${req.originalUrl}`;

    // Build fetch options
    const fetchOpts = {
      method: req.method,
      headers: {},
      referer: `https://www.google.com/`,  // botasaurus Google referrer trick
    };

    if (req.headers["cookie"]) {
      fetchOpts.headers["Cookie"] = req.headers["cookie"];
    }
    if (req.headers["content-type"]) {
      fetchOpts.headers["Content-Type"] = req.headers["content-type"];
    }
    if (req.method !== "GET" && req.method !== "HEAD" && req.body) {
      fetchOpts.body = req.body;
    }

    let response = await proxyFetch(targetUrl, fetchOpts);

    // Handle redirects
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const locationHeader = response.headers.get("location");
      if (locationHeader) {
        let redirectUrl;
        try {
          redirectUrl = new URL(locationHeader, targetUrl);
        } catch {
          redirectUrl = new URL(locationHeader);
        }
        if (redirectUrl.hostname === ORIGINAL_HOST) {
          redirectUrl.hostname = new URL(origin).hostname;
          redirectUrl.protocol = new URL(origin).protocol;
        }
        return res.redirect(response.status, redirectUrl.toString());
      }
    }

    // Copy response headers
    const responseHeaders = {};
    response.headers.forEach((value, key) => {
      const lowerKey = key.toLowerCase();
      if (
        lowerKey === "content-encoding" ||
        lowerKey === "transfer-encoding" ||
        lowerKey === "content-length" ||
        lowerKey === "content-security-policy" ||
        lowerKey === "strict-transport-security" ||
        lowerKey === "x-frame-options" ||
        lowerKey === "x-robots-tag"
      ) return;
      responseHeaders[key] = value;
    });
    responseHeaders["Access-Control-Allow-Origin"] = "*";
    responseHeaders["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
    responseHeaders["Vary"] = "Accept-Encoding";

    // Get response body as text
    const bodyText = response.text();

    // Non-HTML content
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html")) {
      if (contentType.includes("text/css") || contentType.includes("javascript")) {
        const rewritten = bodyText
          .replace(new RegExp(`https?://${ORIGINAL_HOST.replace(/\./g, "\\.")}`, "g"), origin)
          .replace(new RegExp(ORIGINAL_HOST.replace(/\./g, "\\."), "g"), mirrorHostname);
        res.set(responseHeaders);
        return res.status(response.status).send(rewritten);
      }
      res.set(responseHeaders);
      return res.status(response.status).send(response.body);
    }

    // -------------------------------------------------------
    // Process HTML
    // -------------------------------------------------------
    const dom = new JSDOM(bodyText, { url: targetUrl });
    const document = dom.window.document;

    transformForSEO(document, targetUrl, origin, mirrorHostname, requestPath);

    let processedHtml = dom.serialize();

    // URL rewriting
    processedHtml = processedHtml
      .replace(new RegExp(`https?://${ORIGINAL_HOST.replace(/\./g, "\\.")}`, "g"), origin)
      .replace(new RegExp(ORIGINAL_HOST.replace(/\./g, "\\."), "g"), mirrorHostname);

    // Neutralize right-click disabling
    processedHtml = processedHtml
      .replace(/oncontextmenu\s*=\s*["'][^"']*["']/gi, "")
      .replace(/oncontextmenu\s*=\s*return\s*false/gi, "")
      .replace(/document\.addEventListener\s*\(\s*['"]contextmenu['"][^)]*\)/gi, "void(0)")
      .replace(/document\.oncontextmenu\s*=\s*function\s*\([^)]*\)\s*\{[^}]*\}/gi, "void(0)");

    // Inject utility scripts + image proxy rewriter for dynamically loaded content
    const utilScript = `
      <script>
        document.addEventListener('contextmenu', function(e) { e.stopImmediatePropagation(); }, true);
        document.oncontextmenu = null;
        window.open = function() { return null; };
        document.addEventListener('click', function(e) {
          var t = e.target.closest('a');
          if (t && t.href && (t.href.includes('clickadu') || t.href.includes('juicyads') || t.href.includes('exoclick'))) {
            e.preventDefault(); e.stopPropagation();
          }
        }, true);

        // Rewrite dynamically loaded images (AJAX responses) to use image proxy
        (function() {
          var proxyDomains = ['desu.photos', 'cdn.doujindesu.dev', 'doujindesu.moe', 'doujindesu.tv', 'doujindesu.xxx', 'doujindesu.dev'];
          var proxyPath = '/image-proxy/';
          function shouldProxy(url) {
            if (!url) return false;
            for (var i = 0; i < proxyDomains.length; i++) {
              if (url.indexOf(proxyDomains[i]) !== -1) return true;
            }
            return false;
          }
          function proxyImages(container) {
            if (!container) return;
            var imgs = container.querySelectorAll('img');
            for (var i = 0; i < imgs.length; i++) {
              var src = imgs[i].getAttribute('src');
              if (src && shouldProxy(src) && src.indexOf(proxyPath) === -1) {
                imgs[i].setAttribute('src', proxyPath + encodeURIComponent(src));
              }
              var dsrc = imgs[i].getAttribute('data-src');
              if (dsrc && shouldProxy(dsrc) && dsrc.indexOf(proxyPath) === -1) {
                imgs[i].setAttribute('data-src', proxyPath + encodeURIComponent(dsrc));
              }
            }
          }
          // Observe #anu for dynamic content injection
          var anu = document.getElementById('anu');
          if (anu) {
            var observer = new MutationObserver(function(mutations) {
              mutations.forEach(function(m) {
                if (m.addedNodes.length > 0) proxyImages(anu);
              });
            });
            observer.observe(anu, { childList: true, subtree: true });
          }
          // Also observe entire document for lazy-loaded images
          var bodyObserver = new MutationObserver(function(mutations) {
            mutations.forEach(function(m) {
              for (var i = 0; i < m.addedNodes.length; i++) {
                var node = m.addedNodes[i];
                if (node.nodeType === 1) proxyImages(node);
              }
            });
          });
          if (document.body) bodyObserver.observe(document.body, { childList: true, subtree: true });
        })();
      </script>
    `;
    processedHtml = processedHtml.replace(/<\/head>/i, `${utilScript}</head>`);

    // Unique footer
    const uniqueFooter = `
      <div id="mirror-info" style="background:#f8f9fa;border-top:1px solid #e9ecef;padding:15px 20px;text-align:center;font-size:13px;color:#6c757d;margin-top:20px;">
        <p style="margin:0 0 5px">&copy; ${new Date().getFullYear()} ${SITE_NAME} - ${SITE_TAGLINE}</p>
        <p style="margin:0;font-size:11px;">Konten disediakan untuk kemudahan akses pembaca Indonesia.</p>
      </div>
    `;
    processedHtml = processedHtml.replace(/<\/body>/i, `${uniqueFooter}</body>`);

    // Cache
    if (req.method === "GET" && response.status === 200) {
      pageCache.set(cacheKey, { body: processedHtml, headers: responseHeaders, status: response.status });
    }

    res.set(responseHeaders);
    res.status(response.status).send(processedHtml);
  } catch (error) {
    console.error("Proxy error:", error.message);

    const cacheKey = `GET:${req.originalUrl}`;
    const stale = pageCache.get(cacheKey, { allowStale: true });
    if (stale) {
      res.set(stale.headers);
      res.set("X-Cache", "STALE");
      return res.status(stale.status).send(stale.body);
    }

    res.status(502).set({ "Content-Type": "text/html" }).send(
      `<!DOCTYPE html><html><head><title>Temporary Error - ${SITE_NAME}</title></head>` +
      `<body style="font-family:sans-serif;text-align:center;padding:50px">` +
      `<h1>Halaman Sedang Tidak Tersedia</h1>` +
      `<p>Silakan coba beberapa saat lagi.</p>` +
      `<p><a href="/">Kembali ke Beranda</a></p></body></html>`
    );
  }
});

// ============================================================
// Start server
// ============================================================
async function start() {
  await detectCurl();

  // Pre-warm: fetch the homepage to get Cloudflare cookies
  console.log("🔥 Pre-warming Cloudflare cookies...");
  try {
    const response = await curlFetch(`https://${ORIGINAL_HOST}/`, {
      referer: "https://www.google.com/",
    });
    const text = response.text();
    if (isCloudflareChallenge(text)) {
      console.log("⚠️  Cloudflare challenge detected on pre-warm, cookies may help on retry");
    } else {
      console.log("✅ Pre-warm successful, Cloudflare cookies acquired");
    }
  } catch (err) {
    console.warn("⚠️  Pre-warm failed:", err.message);
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`✅ ${SITE_NAME} mirror running on port ${PORT}`);
    console.log(`   Target: ${ORIGINAL_HOST}`);
    console.log(`   Curl: ${curlBinary} (impersonate: ${curlImpersonateAvailable})`);
    console.log(`   Cache: ${pageCache.max} pages, ${imageCache.max} images`);
    console.log(`   Cookies: ${COOKIE_FILE}`);
  });
}

start().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
