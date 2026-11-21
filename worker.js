/**
 * WAT KOH FAMILY & COMMUNITY HEALTH SYSTEM
 * Cloudflare Worker - CORS / transparent proxy for the existing Google Apps Script API
 *
 * IMPORTANT: This Worker intentionally preserves the existing frontend transport:
 *   - GET + JSONP for public system.info / system.health
 *   - POST application/x-www-form-urlencoded containing `payload=<JSON>`
 *   - GAS returns HTML with window.top.postMessage(...)
 *   - Worker passes that HTML through unchanged, so the current iframe + nonce checks
 *     in index.html and dashboard.html continue to work.
 *
 * Required Worker variables:
 *   GAS_WEB_APP_URL  = https://script.google.com/macros/s/DEPLOYMENT_ID/exec
 *   ALLOWED_ORIGINS  = https://YOUR-ACCOUNT.github.io
 *                      (comma-separated if you use more than one exact origin)
 *
 * Do NOT put an ImgBB API key, spreadsheet ID, password, or session token in this file.
 */

const PUBLIC_GET_ACTIONS = new Set([
  'system.info',
  'system.health'
]);

const ALLOWED_POST_ACTIONS = new Set([
  'system.info',
  'system.health',
  'system.clearSessions',
  'system.installReminders',
  'system.logs.list',
  'auth.login',
  'auth.logout',
  'auth.me',
  'auth.changePassword',
  'users.list',
  'users.create',
  'users.update',
  'users.resetPassword',
  'users.toggle',
  'settings.list',
  'settings.update',
  'lookups.list',
  'lookups.save',
  'villages.list',
  'villages.create',
  'villages.update',
  'assignments.list',
  'assignments.create',
  'assignments.update',
  'assignments.archive',
  'households.list',
  'households.get',
  'households.dossier',
  'households.create',
  'households.update',
  'households.archive',
  'members.list',
  'members.get',
  'members.create',
  'members.update',
  'members.archive',
  'members.move',
  'relations.list',
  'relations.create',
  'relations.update',
  'relations.delete',
  'health.screenings.list',
  'health.screenings.create',
  'health.screenings.update',
  'health.chronic.list',
  'health.chronic.create',
  'health.chronic.update',
  'health.risks.list',
  'health.risks.create',
  'health.risks.update',
  'health.vaccinations.list',
  'health.vaccinations.create',
  'health.vaccinations.update',
  'visits.list',
  'visits.create',
  'visits.update',
  'appointments.list',
  'appointments.create',
  'appointments.update',
  'volunteer.submit',
  'volunteer.mySubmissions',
  'approvals.list',
  'approvals.review',
  'search.global',
  'dashboard.stats',
  'notifications.list',
  'notifications.markRead',
  'reports.data',
  'reports.exportData',
  'audit.list',
  'files.uploadImage',
  'backup.exportJson',
  'import.bulk'
]);

const MAX_POST_BYTES = 12 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 25000;

export default {
  async fetch(request, env) {
    const requestUrl = new URL(request.url);

    if (requestUrl.pathname === '/_health') {
      return jsonResponse({
        success: true,
        service: 'watkao-cors-worker',
        timestamp: new Date().toISOString()
      }, 200, new Headers({ 'Cache-Control': 'no-store' }));
    }

    if (requestUrl.pathname !== '/' && requestUrl.pathname !== '') {
      return jsonResponse({ success: false, message: 'ไม่พบปลายทางที่เรียกใช้' }, 404);
    }

    const upstreamUrl = getConfiguredGasUrl(env);
    if (!upstreamUrl) {
      return request.method === 'POST'
        ? await postErrorFromRequest_(request, 'ระบบยังไม่ได้ตั้งค่าการเชื่อมต่อฐานข้อมูล', 500)
        : jsonResponse({ success: false, message: 'ระบบยังไม่ได้ตั้งค่าการเชื่อมต่อฐานข้อมูล' }, 500);
    }

    const callerOrigin = getCallerOrigin(request);
    const allowedOrigins = getAllowedOrigins(env);
    const originAllowed = !!callerOrigin && allowedOrigins.has(callerOrigin);

    if (request.method === 'OPTIONS') {
      if (!originAllowed) {
        return jsonResponse({ success: false, message: 'ไม่อนุญาตให้เชื่อมต่อจากเว็บไซต์นี้' }, 403);
      }
      return optionsResponse(callerOrigin);
    }

    if (request.method === 'GET') {
      return proxyGet(request, upstreamUrl, callerOrigin, originAllowed);
    }

    if (request.method === 'POST') {
      return proxyPost(request, upstreamUrl, callerOrigin, originAllowed);
    }

    return new Response('Method Not Allowed', {
      status: 405,
      headers: {
        'Allow': 'GET, POST, OPTIONS',
        'Cache-Control': 'no-store'
      }
    });
  }
};

// =====================================================================================
// 01. WORKER CONFIGURATION
// =====================================================================================

function getConfiguredGasUrl(env) {
  const raw = String(env.GAS_WEB_APP_URL || '').trim();
  if (!raw) return null;

  try {
    const url = new URL(raw);
    const validHost = url.protocol === 'https:' && url.hostname === 'script.google.com';
    const validPath = /^\/macros\/s\/[^/]+\/exec$/.test(url.pathname);
    if (!validHost || !validPath) return null;
    url.search = '';
    url.hash = '';
    return url;
  } catch (error) {
    return null;
  }
}

function getAllowedOrigins(env) {
  const raw = String(env.ALLOWED_ORIGINS || '');
  const origins = raw.split(',').map(value => value.trim()).filter(Boolean);
  const normalized = new Set();

  for (const item of origins) {
    try {
      const url = new URL(item);
      if (url.protocol === 'https:' || url.hostname === 'localhost') {
        normalized.add(url.origin);
      }
    } catch (error) {
      // Ignore invalid entries. Only exact origins are accepted.
    }
  }

  return normalized;
}

function getCallerOrigin(request) {
  const originHeader = request.headers.get('Origin');
  if (originHeader && originHeader !== 'null') {
    try {
      return new URL(originHeader).origin;
    } catch (error) {
      return '';
    }
  }

  const referer = request.headers.get('Referer');
  if (referer) {
    try {
      return new URL(referer).origin;
    } catch (error) {
      return '';
    }
  }

  return '';
}

// =====================================================================================
// 02. CORS HEADERS AND PREFLIGHT
// =====================================================================================

function corsHeaders(origin) {
  const headers = new Headers();
  headers.set('Vary', 'Origin');
  headers.set('Cache-Control', 'no-store');

  if (origin) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
    headers.set('Access-Control-Max-Age', '86400');
  }

  return headers;
}

function optionsResponse(origin) {
  const headers = corsHeaders(origin);
  headers.set('Content-Length', '0');
  return new Response(null, { status: 204, headers });
}

function addCorsToResponse(response, origin) {
  const headers = new Headers(response.headers);

  // The upstream content can be transparently streamed from GAS. Remove headers that
  // may be invalid after Cloudflare has decoded/reframed the upstream response.
  headers.delete('Content-Length');
  headers.delete('Content-Encoding');
  headers.delete('Transfer-Encoding');
  headers.set('Cache-Control', 'no-store');
  headers.set('Vary', 'Origin');

  if (origin) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
    headers.set('Access-Control-Max-Age', '86400');
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

// =====================================================================================
// 03. PUBLIC GET / JSONP PROXY
// =====================================================================================

async function proxyGet(request, upstreamBaseUrl, callerOrigin, originAllowed) {
  const incomingUrl = new URL(request.url);
  const action = String(incomingUrl.searchParams.get('action') || 'system.info').trim();
  const callback = String(incomingUrl.searchParams.get('callback') || '').trim();

  if (!PUBLIC_GET_ACTIONS.has(action)) {
    return jsonpOrJsonError(callback, 'ไม่อนุญาตให้เรียกใช้ API รายการนี้ผ่าน GET', 405, callerOrigin && originAllowed ? callerOrigin : '');
  }

  // Public GET is deliberately limited to non-personal system status endpoints.
  // If browser origin information is available, it still must match the allowlist.
  if (callerOrigin && !originAllowed) {
    return jsonpOrJsonError(callback, 'ไม่อนุญาตให้เชื่อมต่อจากเว็บไซต์นี้', 403, '');
  }

  const target = new URL(upstreamBaseUrl.toString());
  target.search = incomingUrl.search;

  try {
    const response = await fetchWithTimeout(target.toString(), {
      method: 'GET',
      headers: { 'Accept': 'application/javascript, application/json, text/plain, */*' },
      redirect: 'follow'
    });

    if (!response.ok) {
      return jsonpOrJsonError(callback, 'บริการฐานข้อมูลไม่พร้อมใช้งาน กรุณาลองใหม่อีกครั้ง', 502,
        callerOrigin && originAllowed ? callerOrigin : '');
    }

    return addCorsToResponse(response, callerOrigin && originAllowed ? callerOrigin : '');
  } catch (error) {
    return jsonpOrJsonError(callback, 'ไม่สามารถติดต่อบริการฐานข้อมูลได้ กรุณาลองใหม่อีกครั้ง', 502,
      callerOrigin && originAllowed ? callerOrigin : '');
  }
}

function jsonpOrJsonError(callback, message, status, origin) {
  const safeMessage = String(message || 'เกิดข้อผิดพลาด');
  const body = {
    success: false,
    message: safeMessage,
    requestId: 'WORKER-' + crypto.randomUUID()
  };
  const validCallback = /^[A-Za-z_$][A-Za-z0-9_$\.]{0,100}$/.test(callback);
  const headers = corsHeaders(origin);

  if (validCallback) {
    headers.set('Content-Type', 'application/javascript; charset=utf-8');
    return new Response(callback + '(' + JSON.stringify(body) + ');', { status, headers });
  }

  headers.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(body), { status, headers });
}

// =====================================================================================
// 04. EXISTING FORM POST / IFRAME / postMessage PROXY
// =====================================================================================

async function proxyPost(request, upstreamBaseUrl, callerOrigin, originAllowed) {
  let bodyText = '';
  let payload = null;
  let nonce = '';
  let requestId = 'WORKER-' + crypto.randomUUID();

  try {
    const contentType = String(request.headers.get('Content-Type') || '').toLowerCase();
    if (!contentType.includes('application/x-www-form-urlencoded')) {
      return bridgeErrorResponse_('รูปแบบคำขอไม่ถูกต้อง กรุณาลองใหม่อีกครั้ง', nonce, requestId, 415, callerOrigin);
    }

    bodyText = await request.text();
    if (new TextEncoder().encode(bodyText).byteLength > MAX_POST_BYTES) {
      return bridgeErrorResponse_('ข้อมูลที่ส่งมีขนาดใหญ่เกินกำหนด', nonce, requestId, 413, callerOrigin);
    }

    const form = new URLSearchParams(bodyText);
    const rawPayload = form.get('payload') || form.get('data') || '';
    if (!rawPayload) {
      return bridgeErrorResponse_('ไม่พบข้อมูลคำขอ กรุณาลองใหม่อีกครั้ง', nonce, requestId, 400, callerOrigin);
    }

    try {
      payload = JSON.parse(rawPayload);
    } catch (error) {
      return bridgeErrorResponse_('ข้อมูลคำขอไม่ถูกต้อง กรุณาลองใหม่อีกครั้ง', nonce, requestId, 400, callerOrigin);
    }

    nonce = String(payload && payload.nonce || '');
    requestId = String(payload && payload.requestId || requestId);
    const action = String(payload && payload.action || '').trim();

    if (!ALLOWED_POST_ACTIONS.has(action)) {
      return bridgeErrorResponse_('ไม่อนุญาตให้เรียกใช้ API รายการนี้', nonce, requestId, 405, callerOrigin);
    }

    if (!callerOrigin || !originAllowed) {
      return bridgeErrorResponse_('ไม่อนุญาตให้เชื่อมต่อจากเว็บไซต์นี้ กรุณาแจ้งผู้ดูแลระบบ', nonce, requestId, 403, '');
    }

    const upstreamHeaders = new Headers();
    upstreamHeaders.set('Content-Type', request.headers.get('Content-Type') || 'application/x-www-form-urlencoded; charset=UTF-8');
    upstreamHeaders.set('Accept', 'text/html, application/xhtml+xml, */*');

    const upstreamResponse = await fetchWithTimeout(upstreamBaseUrl.toString(), {
      method: 'POST',
      headers: upstreamHeaders,
      body: bodyText,
      redirect: 'follow'
    });

    if (!upstreamResponse.ok) {
      return bridgeErrorResponse_('บริการฐานข้อมูลไม่พร้อมใช้งาน กรุณาลองใหม่อีกครั้ง', nonce, requestId, 502, callerOrigin);
    }

    const upstreamContentType = String(upstreamResponse.headers.get('Content-Type') || '').toLowerCase();
    if (!upstreamContentType.includes('text/html')) {
      return bridgeErrorResponse_('ระบบฐานข้อมูลส่งผลตอบกลับไม่ถูกต้อง กรุณาติดต่อผู้ดูแลระบบ', nonce, requestId, 502, callerOrigin);
    }

    // Crucial: do not parse or rewrite the GAS HTML. Its inline script posts the exact
    // { __watkSystem, nonce, payload } message the existing frontend already expects.
    return addCorsToResponse(upstreamResponse, callerOrigin);

  } catch (error) {
    return bridgeErrorResponse_('ไม่สามารถติดต่อบริการฐานข้อมูลได้ กรุณาลองใหม่อีกครั้ง', nonce, requestId, 502,
      callerOrigin && originAllowed ? callerOrigin : '');
  }
}

async function postErrorFromRequest_(request, message, status) {
  let nonce = '';
  let requestId = 'WORKER-' + crypto.randomUUID();
  try {
    const raw = await request.text();
    const params = new URLSearchParams(raw);
    const payload = JSON.parse(params.get('payload') || '{}');
    nonce = String(payload.nonce || '');
    requestId = String(payload.requestId || requestId);
  } catch (error) {}
  return bridgeErrorResponse_(message, nonce, requestId, status, '');
}

function bridgeErrorResponse_(message, nonce, requestId, status, origin) {
  const safeMessage = String(message || 'ไม่สามารถดำเนินการได้ กรุณาลองใหม่อีกครั้ง');
  const messageObject = {
    __watkSystem: true,
    requestId: String(requestId || ''),
    nonce: String(nonce || ''),
    payload: {
      success: false,
      message: safeMessage,
      requestId: String(requestId || '')
    }
  };
  const safeJson = JSON.stringify(messageObject)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');

  const html = '<!doctype html><html><head><meta charset="utf-8"></head><body>' +
    '<script>(function(){var message=' + safeJson + ';' +
    'try{window.top.postMessage(message,"*");}catch(e){try{window.parent.postMessage(message,"*");}catch(ignore){}}' +
    '})();</script></body></html>';

  const headers = corsHeaders(origin);
  headers.set('Content-Type', 'text/html; charset=utf-8');
  headers.set('X-Content-Type-Options', 'nosniff');
  return new Response(html, { status, headers });
}

// =====================================================================================
// 05. SHARED HELPERS
// =====================================================================================

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort('upstream timeout'), UPSTREAM_TIMEOUT_MS);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

function jsonResponse(value, status = 200, headers = new Headers()) {
  const responseHeaders = new Headers(headers);
  responseHeaders.set('Content-Type', 'application/json; charset=utf-8');
  responseHeaders.set('Cache-Control', 'no-store');
  return new Response(JSON.stringify(value), { status, headers: responseHeaders });
}
