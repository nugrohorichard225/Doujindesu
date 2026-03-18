import express from "express";
import fetch from "node-fetch";
import { JSDOM } from "jsdom";

const app = express();
const PORT = process.env.PORT || 3000;
const ORIGINAL_HOST = "doujindesu.tv";
const IMAGE_PROXY_PATH = "/image-proxy/";

// Parse raw body untuk forward POST requests
app.use(express.raw({ type: "*/*", limit: "50mb" }));

// Helper: cek apakah Googlebot
function isGooglebot(req) {
  return (req.headers["user-agent"] || "").includes("Googlebot");
}

// Helper: dapatkan origin dari request
function getOrigin(req) {
  const protocol = req.headers["x-forwarded-proto"] || req.protocol || "https";
  const host = req.headers["x-forwarded-host"] || req.headers["host"];
  return `${protocol}://${host}`;
}

// Helper: dapatkan User-Agent yang akan digunakan
function getProxyUserAgent(req) {
  if (isGooglebot(req)) {
    return "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
  }
  return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";
}

// ============================================================
// Route: robots.txt
// ============================================================
app.get("/robots.txt", (req, res) => {
  const origin = getOrigin(req);
  const robotsTxt = `User-agent: *
Allow: /
Sitemap: ${origin}/sitemap.xml`;

  res.set({
    "Content-Type": "text/plain",
    "Cache-Control": "public, max-age=86400",
    "Access-Control-Allow-Origin": "*",
  });
  res.status(200).send(robotsTxt);
});

// ============================================================
// Route: Image Proxy
// ============================================================
app.get(`${IMAGE_PROXY_PATH}*`, async (req, res) => {
  try {
    const imageUrl = decodeURIComponent(
      req.originalUrl.replace(IMAGE_PROXY_PATH, "")
    );

    const imageResponse = await fetch(imageUrl, {
      method: "GET",
      headers: {
        Host: "desu.photos",
        Referer: `https://${ORIGINAL_HOST}/`,
        Origin: `https://${ORIGINAL_HOST}`,
        "User-Agent": getProxyUserAgent(req),
      },
    });

    if (!imageResponse.ok) {
      return res.status(imageResponse.status).send("Image fetch failed");
    }

    res.set({
      "Content-Type": imageResponse.headers.get("content-type") || "image/webp",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=31536000",
    });

    // Stream image body ke client
    imageResponse.body.pipe(res);
  } catch (error) {
    console.error("Image proxy error:", error.message);
    res.status(500).send(`Image proxy error: ${error.message}`);
  }
});

// ============================================================
// Route: Semua request lainnya (proxy ke target site)
// ============================================================
app.all("*", async (req, res) => {
  try {
    const origin = getOrigin(req);
    const targetUrl = new URL(req.originalUrl, `https://${ORIGINAL_HOST}`);
    targetUrl.hostname = ORIGINAL_HOST;

    // Build headers untuk request ke target
    const proxyHeaders = {
      Host: ORIGINAL_HOST,
      Referer: targetUrl.toString(),
      Origin: `https://${ORIGINAL_HOST}`,
      "User-Agent": getProxyUserAgent(req),
      Accept: req.headers["accept"] || "*/*",
      "Accept-Language": req.headers["accept-language"] || "en-US,en;q=0.9",
      "Accept-Encoding": "identity", // Hindari compressed response agar bisa modifikasi HTML
    };

    // Forward cookies jika ada
    if (req.headers["cookie"]) {
      proxyHeaders["Cookie"] = req.headers["cookie"];
    }

    // Forward content-type untuk POST requests
    if (req.headers["content-type"]) {
      proxyHeaders["Content-Type"] = req.headers["content-type"];
    }

    // Fetch dari target site
    const fetchOptions = {
      method: req.method,
      headers: proxyHeaders,
      redirect: "manual", // Handle redirect secara manual
    };

    // Attach body untuk non-GET/HEAD requests
    if (req.method !== "GET" && req.method !== "HEAD" && req.body) {
      fetchOptions.body = req.body;
    }

    let response = await fetch(targetUrl.toString(), fetchOptions);

    // -------------------------------------------------------
    // Handle redirects secara manual
    // -------------------------------------------------------
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const locationHeader = response.headers.get("location");
      if (locationHeader) {
        const redirectUrl = new URL(locationHeader, targetUrl.toString());
        if (redirectUrl.hostname === ORIGINAL_HOST) {
          const workerHost = new URL(origin);
          redirectUrl.hostname = workerHost.hostname;
          redirectUrl.protocol = workerHost.protocol;
        }
        return res.redirect(response.status, redirectUrl.toString());
      }
    }

    // -------------------------------------------------------
    // Copy response headers
    // -------------------------------------------------------
    const responseHeaders = {};
    response.headers.forEach((value, key) => {
      const lowerKey = key.toLowerCase();
      // Skip headers yang bisa menyebabkan masalah
      if (
        lowerKey === "content-encoding" ||
        lowerKey === "transfer-encoding" ||
        lowerKey === "content-length"
      ) {
        return;
      }
      responseHeaders[key] = value;
    });

    // SEO headers
    responseHeaders["Vary"] = "User-Agent";
    delete responseHeaders["x-robots-tag"];
    delete responseHeaders["X-Robots-Tag"];

    // CORS headers
    responseHeaders["Access-Control-Allow-Origin"] = "*";
    responseHeaders["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
    delete responseHeaders["x-frame-options"];
    delete responseHeaders["X-Frame-Options"];

    // -------------------------------------------------------
    // Jika bukan HTML, langsung stream response
    // -------------------------------------------------------
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html")) {
      res.set(responseHeaders);
      res.status(response.status);
      response.body.pipe(res);
      return;
    }

    // -------------------------------------------------------
    // Process HTML content
    // -------------------------------------------------------
    let html = await response.text();

    // --- DOM Manipulation (pengganti HTMLRewriter) ---
    const dom = new JSDOM(html, { url: targetUrl.toString() });
    const document = dom.window.document;

    // Remove ad container dengan id="container"
    const adContainer = document.querySelector("div#container");
    if (adContainer) adContainer.remove();

    // Remove banner ads dengan class="blox mlb kln"
    document.querySelectorAll("div.blox.mlb.kln").forEach((el) => el.remove());

    // Remove fixed ad container dengan z-index tinggi
    document
      .querySelectorAll('div[class=""][style*="z-index: 2147483647"]')
      .forEach((el) => el.remove());

    // Remove ad scripts dari clickadu
    document
      .querySelectorAll('script[src*="adv.clickadu.net"]')
      .forEach((el) => el.remove());

    // Remove inline onclick event handlers
    document.querySelectorAll("*[onclick]").forEach((el) => {
      el.removeAttribute("onclick");
    });

    // Rewrite image URLs ke image proxy
    document.querySelectorAll('img[src*="desu.photos"]').forEach((el) => {
      const src = el.getAttribute("src");
      if (src) {
        el.setAttribute("src", `${IMAGE_PROXY_PATH}${encodeURIComponent(src)}`);
      }
    });

    // Googlebot-specific SEO modifications
    const googlebotRequest = isGooglebot(req);
    if (googlebotRequest) {
      // Modify <title>
      const titleEl = document.querySelector("title");
      if (titleEl) {
        const originalTitle = titleEl.textContent || "Doujindesu Mirror";
        titleEl.textContent = `Mirror: ${originalTitle} - Doujindesu Mirror`;
      }

      // Modify meta description
      const metaDesc = document.querySelector('meta[name="description"]');
      if (metaDesc) {
        const originalDesc =
          metaDesc.getAttribute("content") || "Manga and comic content";
        metaDesc.setAttribute(
          "content",
          `Mirror of ${originalDesc} - Provided by Doujindesu Mirror`
        );
      }

      // Add meta robots
      const head = document.querySelector("head");
      if (head) {
        const metaRobots = document.createElement("meta");
        metaRobots.setAttribute("name", "robots");
        metaRobots.setAttribute("content", "index, follow");
        head.appendChild(metaRobots);

        // Add canonical link
        const canonical = document.createElement("link");
        canonical.setAttribute("rel", "canonical");
        canonical.setAttribute("href", targetUrl.toString());
        head.appendChild(canonical);
      }

      // Remove noindex meta tags
      document
        .querySelectorAll('meta[name="robots"]')
        .forEach((el) => {
          const content = el.getAttribute("content") || "";
          if (content.toLowerCase().includes("noindex")) {
            el.remove();
          }
        });
    }

    // Serialize kembali ke HTML string
    let originalBody = dom.serialize();

    // -------------------------------------------------------
    // String replacements (URL rewriting)
    // -------------------------------------------------------
    const workerOrigin = origin;
    const workerHostname = new URL(origin).hostname;

    originalBody = originalBody
      .replace(/https?:\/\/doujindesu\.tv/g, workerOrigin)
      .replace(/doujindesu\.tv/g, workerHostname);

    // Neutralize right-click disabling scripts
    originalBody = originalBody
      .replace(/oncontextmenu\s*=\s*["'][^"']*["']/gi, "")
      .replace(/oncontextmenu\s*=\s*return\s*false/gi, "")
      .replace(
        /document\.addEventListener\s*\(\s*['"]contextmenu['"][^)]*\)/gi,
        "/* Right-click event listener removed */"
      )
      .replace(
        /document\.oncontextmenu\s*=\s*function\s*\([^)]*\)\s*{[^}]*}/gi,
        "/* Right-click function removed */"
      )
      .replace(/return\s*false\s*;/g, "");

    // Inject anti-redirect & re-enable right-click script
    const antiRedirectScript = `
      <script>
        // Prevent right-click restrictions
        document.addEventListener('contextmenu', function(e) {
          e.stopImmediatePropagation();
        }, true);
        document.oncontextmenu = null;

        // Block redirects
        const originalLocation = window.location;
        const originalDocumentLocation = document.location;
        Object.defineProperty(window, 'location', {
          value: originalLocation,
          writable: false,
        });
        Object.defineProperty(document, 'location', {
          value: originalDocumentLocation,
          writable: false,
        });

        // Block window.open redirects
        window.open = function() { return null; };

        // Remove ad click handlers
        document.addEventListener('click', function(e) {
          if (e.target.tagName === 'A' && e.target.href && e.target.href.includes('adv.clickadu.net')) {
            e.preventDefault();
            e.stopPropagation();
          }
        }, true);
      </script>
    `;
    originalBody = originalBody.replace(/<\/head>/i, `${antiRedirectScript}</head>`);

    // Googlebot unique footer
    if (googlebotRequest) {
      const uniqueFooter = `
        <footer style="font-size: 12px; color: #666; text-align: center; padding: 10px;">
          This is a mirrored version of the original content, provided by Doujindesu Mirror for enhanced accessibility.
        </footer>
      `;
      originalBody = originalBody.replace(/<\/body>/i, `${uniqueFooter}</body>`);
    }

    res.set(responseHeaders);
    res.status(response.status).send(originalBody);
  } catch (error) {
    console.error("Proxy error:", error.message);
    res.status(500).set({ "Content-Type": "text/plain" }).send(`Error: ${error.message}`);
  }
});

// ============================================================
// Start server
// ============================================================
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Reverse proxy server running on port ${PORT}`);
});