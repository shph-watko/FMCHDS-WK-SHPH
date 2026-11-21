/**
 * WAT KOH FAMILY & COMMUNITY HEALTH SYSTEM
 * Cloudflare Worker API Gateway
 *
 * Browser -> Cloudflare Worker (/api) -> Google Apps Script Web App -> Google Sheets
 *
 * Worker responsibilities:
 * - Single public API endpoint for index.html and dashboard.html.
 * - Exact Origin allow-list and CORS preflight support.
 * - JSON request/response transport (no JSONP, hidden form, iframe, or postMessage).
 * - Adds a private shared secret before forwarding to the existing Apps Script API.
 * - Follows the ContentService redirect from script.google.com to googleusercontent.com.
 * - Returns structured errors with a request ID for diagnosis.
 *
 * Required Worker settings:
 *   GAS_WEB_APP_URL   (Variable) = https://script.google.com/macros/s/<DEPLOYMENT_ID>/exec
 *   ALLOWED_ORIGINS   (Variable) = https://<github-user>.github.io
 *   GAS_SHARED_SECRET (Secret)   = same random value as Apps Script Script Property
 *                                    WORKER_SHARED_SECRET
 */

const WORKER_VERSION = '2.0.0';
const API_PATH = '/api';
const HEALTH_PATHS = new Set(['/', '/_health', '/health']);
const PUBLIC_GET_ACTIONS = new Set(['system.info', 'system.health']);
const MAX_REQUEST_BYTES = 12 * 1024 * 1024;
const UPSTREAM_REDIRECT_LIMIT = 5;

export default {
  async fetch(request, env, ctx) {
    const requestId = crypto.randomUUID();
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const allowedOrigins = parseAllowedOrigins(env.ALLOWED_ORIGINS);
    const originAllowed = !origin || allowedOrigins.has(origin);

    if (request.method === 'OPTIONS') {
      if (!origin || !allowedOrigins.has(origin)) {
        return jsonResponse({
          success: false,
          message: 'ไม่อนุญาตให้เชื่อมต่อจากเว็บไซต์นี้',
          requestId
        }, 403, corsHeaders('', false));
      }
      return new Response(null, {
        status: 204,
        headers: corsHeaders(origin, true)
      });
    }

    if (!originAllowed) {
      return jsonResponse({
        success: false,
        message: 'ไม่อนุญาตให้เชื่อมต่อจากเว็บไซต์นี้',
        requestId
      }, 403, corsHeaders('', false));
    }

    if (request.method === 'GET' && HEALTH_PATHS.has(url.pathname)) {
      return jsonResponse({
        success: true,
        service: 'wat-koh-family-health-api',
        version: WORKER_VERSION,
        gasConfigured: Boolean(env.GAS_WEB_APP_URL),
        sharedSecretConfigured: Boolean(env.GAS_SHARED_SECRET),
        allowedOriginCount: allowedOrigins.size,
        timestamp: new Date().toISOString()
      }, 200, corsHeaders(origin, originAllowed));
    }

    if (url.pathname !== API_PATH) {
      return jsonResponse({
        success: false,
        message: 'ไม่พบ API endpoint',
        requestId
      }, 404, corsHeaders(origin, originAllowed));
    }

    if (!env.GAS_WEB_APP_URL || !env.GAS_SHARED_SECRET) {
      return jsonResponse({
        success: false,
        message: 'Worker ยังตั้งค่า GAS_WEB_APP_URL หรือ GAS_SHARED_SECRET ไม่ครบ',
        requestId
      }, 500, corsHeaders(origin, originAllowed));
    }

    let gasUrl;
    try {
      gasUrl = validateGasUrl(env.GAS_WEB_APP_URL);
    } catch (error) {
      return jsonResponse({
        success: false,
        message: error.message,
        requestId
      }, 500, corsHeaders(origin, originAllowed));
    }

    try {
      let upstreamResponse;

      if (request.method === 'GET') {
        // Convenience read endpoint for browser/manual diagnostics. Forward as POST so
        // the private gateway key stays in the request body, not in a URL/query string.
        const action = String(url.searchParams.get('action') || 'system.info').trim();
        if (!PUBLIC_GET_ACTIONS.has(action)) {
          return jsonResponse({
            success: false,
            message: 'อนุญาตให้อ่านผ่าน GET เฉพาะข้อมูลสถานะระบบเท่านั้น',
            requestId
          }, 405, corsHeaders(origin, originAllowed));
        }

        const upstreamPayload = {
          action,
          data: {},
          token: '',
          requestId,
          workerKey: env.GAS_SHARED_SECRET
        };
        const formBody = new URLSearchParams();
        formBody.set('payload', JSON.stringify(upstreamPayload));

        upstreamResponse = await fetchFollowingAppsScriptRedirects(gasUrl.toString(), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
            'Accept': 'application/json'
          },
          body: formBody.toString(),
          redirect: 'manual'
        });

      } else if (request.method === 'POST') {
        const contentLength = Number(request.headers.get('Content-Length') || 0);
        if (contentLength > MAX_REQUEST_BYTES) {
          return jsonResponse({
            success: false,
            message: 'ข้อมูลที่ส่งมีขนาดใหญ่เกินกำหนด',
            requestId
          }, 413, corsHeaders(origin, originAllowed));
        }

        const rawBody = await request.text();
        if (new TextEncoder().encode(rawBody).byteLength > MAX_REQUEST_BYTES) {
          return jsonResponse({
            success: false,
            message: 'ข้อมูลที่ส่งมีขนาดใหญ่เกินกำหนด',
            requestId
          }, 413, corsHeaders(origin, originAllowed));
        }

        let clientPayload;
        try {
          clientPayload = JSON.parse(rawBody || '{}');
        } catch (_) {
          return jsonResponse({
            success: false,
            message: 'รูปแบบข้อมูล JSON ไม่ถูกต้อง',
            requestId
          }, 400, corsHeaders(origin, originAllowed));
        }

        if (!clientPayload || typeof clientPayload !== 'object' || Array.isArray(clientPayload)) {
          return jsonResponse({
            success: false,
            message: 'รูปแบบคำขอไม่ถูกต้อง',
            requestId
          }, 400, corsHeaders(origin, originAllowed));
        }

        const action = String(clientPayload.action || '').trim();
        if (!action || action.length > 100) {
          return jsonResponse({
            success: false,
            message: 'ไม่พบรายการที่ต้องการดำเนินการ',
            requestId
          }, 400, corsHeaders(origin, originAllowed));
        }

        // Worker owns the gateway secret and overwrites any client-supplied value.
        const upstreamPayload = {
          action,
          data: clientPayload.data && typeof clientPayload.data === 'object' ? clientPayload.data : {},
          token: String(clientPayload.token || ''),
          requestId: String(clientPayload.requestId || requestId),
          workerKey: env.GAS_SHARED_SECRET
        };

        const formBody = new URLSearchParams();
        formBody.set('payload', JSON.stringify(upstreamPayload));

        upstreamResponse = await fetchFollowingAppsScriptRedirects(gasUrl.toString(), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
            'Accept': 'application/json'
          },
          body: formBody.toString(),
          redirect: 'manual'
        });

      } else {
        return jsonResponse({
          success: false,
          message: 'ไม่รองรับ HTTP method นี้',
          requestId
        }, 405, corsHeaders(origin, originAllowed), { Allow: 'GET, POST, OPTIONS' });
      }

      const responseText = await upstreamResponse.text();
      let apiResult;
      try {
        apiResult = JSON.parse(responseText);
      } catch (_) {
        const isGoogleLoginPage = /accounts\.google\.com|ServiceLogin/i.test(responseText);
        return jsonResponse({
          success: false,
          message: isGoogleLoginPage
            ? 'Google Apps Script ยังไม่ได้เปิดสิทธิ์ Web App เป็น Anyone หรือ URL Deployment ไม่ถูกต้อง'
            : 'Google Apps Script ตอบกลับไม่ใช่ JSON กรุณาตรวจสอบการ Deploy และ doGet/doPost',
          upstreamStatus: upstreamResponse.status,
          upstreamContentType: upstreamResponse.headers.get('Content-Type') || '',
          responsePreview: responseText.slice(0, 240),
          requestId
        }, 502, corsHeaders(origin, originAllowed));
      }

      if (!upstreamResponse.ok) {
        return jsonResponse(apiResult, upstreamResponse.status, corsHeaders(origin, originAllowed));
      }

      return jsonResponse(apiResult, 200, corsHeaders(origin, originAllowed));

    } catch (error) {
      return jsonResponse({
        success: false,
        message: 'เชื่อมต่อ Google Apps Script ไม่สำเร็จ: ' + safeErrorMessage(error),
        requestId
      }, 502, corsHeaders(origin, originAllowed));
    }
  }
};

function parseAllowedOrigins(value) {
  const list = String(value || '')
    .split(/[\n,;]+/)
    .map(item => item.trim().replace(/\/$/, ''))
    .filter(Boolean);
  return new Set(list);
}

function corsHeaders(origin, allowOrigin) {
  const headers = new Headers({
    'Vary': 'Origin',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept',
    'Access-Control-Max-Age': '86400'
  });
  if (origin && allowOrigin) headers.set('Access-Control-Allow-Origin', origin);
  return headers;
}

function jsonResponse(body, status = 200, extraHeaders = {}, additionalHeaders = {}) {
  const headers = new Headers(extraHeaders);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Cache-Control', 'no-store');
  for (const [key, value] of Object.entries(additionalHeaders || {})) {
    headers.set(key, value);
  }
  return new Response(JSON.stringify(body), { status, headers });
}

function validateGasUrl(value) {
  let url;
  try {
    url = new URL(String(value).trim());
  } catch (_) {
    throw new Error('GAS_WEB_APP_URL ไม่ใช่ URL ที่ถูกต้อง');
  }
  if (url.protocol !== 'https:' || url.hostname !== 'script.google.com' || !/\/macros\/s\/[^/]+\/exec$/.test(url.pathname)) {
    throw new Error('GAS_WEB_APP_URL ต้องเป็น URL Web App ของ Google Apps Script ที่ลงท้าย /exec');
  }
  return url;
}

/**
 * Apps Script ContentService responds by redirecting its generated output to a
 * one-time script.googleusercontent.com URL. The POST has already executed at GAS
 * before this response redirect is returned, so 302/303 are followed as GET requests
 * to retrieve the generated JSON. This matches Google's documented ContentService flow.
 */
async function fetchFollowingAppsScriptRedirects(initialUrl, init) {
  let currentUrl = initialUrl;
  let method = init.method || 'GET';
  let body = init.body;
  let headers = new Headers(init.headers || {});

  for (let redirectCount = 0; redirectCount <= UPSTREAM_REDIRECT_LIMIT; redirectCount++) {
    const response = await fetch(currentUrl, {
      method,
      headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : body,
      redirect: 'manual'
    });

    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return response;
    }

    const location = response.headers.get('Location');
    if (!location) return response;

    const nextUrl = new URL(location, currentUrl);
    if (nextUrl.protocol !== 'https:' || !(nextUrl.hostname === 'googleusercontent.com' || nextUrl.hostname.endsWith('.googleusercontent.com'))) {
      return new Response(JSON.stringify({
        success: false,
        message: 'Google Apps Script ส่งต่อไปยังปลายทางที่ไม่อนุญาต',
        redirectHost: nextUrl.hostname
      }), {
        status: 502,
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
      });
    }

    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
      method = 'GET';
      body = undefined;
      headers = new Headers({ 'Accept': 'application/json' });
    }

    currentUrl = nextUrl.toString();
  }

  return new Response(JSON.stringify({
    success: false,
    message: 'Google Apps Script redirect มากเกินจำนวนที่กำหนด'
  }), {
    status: 502,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}

function safeErrorMessage(error) {
  const message = String(error && error.message ? error.message : error || 'Unknown error');
  return message.slice(0, 300);
}
