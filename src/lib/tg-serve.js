// ============================================================================
// src/lib/tg-serve.js
// 从 Telegram 取文件并回给访客的**唯一一份**实现。
//
// 为什么抽出来：现在有两个入口都要分发图片 ——
//   /api/cfile/<file_id>       （老链接，必须继续可用）
//   /i/<file_id>.<ext>         （新的短链，带扩展名）
// 两份逻辑各写一遍，早晚会出现"改了 A 忘了 B"的安全漏洞，
// 所以两个入口都是薄壳，真正的逻辑只在这里。
//
// 本文件同样不 import Cloudflare / Next 专有模块，env / ctx 由调用方传入。
// ============================================================================

import {
  UA,
  IMG_CACHE_CONTROL,
  KNOWN_EXTS,
  getContentType,
  splitExt,
  isInternalReferer,
  hotlinkDecision,
  nowTimeString
} from './tg-common.js';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400', // 24 hours
  'Content-Type': 'application/json'
};

export function corsPreflight() {
  return new Response(null, { headers: corsHeaders });
}

function jsonError(message, status) {
  return Response.json(
    { status, message, success: false },
    { status, headers: corsHeaders }
  );
}

/**
 * 向 Telegram 问"这个 file_id 的文件在哪"。
 * 返回 { ok, path, error } —— 不再返回一个光秃秃的 "error" 字符串，
 * 这样上层能把 Telegram 的原话带给用户，而不是一个看不懂的报错。
 */
async function getFilePath(env, fileId, fetchImpl = fetch) {
  try {
    const url = `https://api.telegram.org/bot${env.TG_BOT_TOKEN}/getFile?file_id=${encodeURIComponent(fileId)}`;
    const res = await fetchImpl(url, { method: 'GET', headers: { 'User-Agent': UA } });
    let data = null;
    try {
      data = await res.json();
    } catch (e) {
      return { ok: false, error: `Telegram 返回了非 JSON 响应（HTTP ${res.status}）` };
    }
    if (data && data.ok && data.result && data.result.file_path) {
      return { ok: true, path: data.result.file_path };
    }
    return { ok: false, error: (data && data.description) || `getFile 失败（HTTP ${res.status}）` };
  } catch (error) {
    return { ok: false, error: (error && error.message) || 'getFile 请求异常' };
  }
}

/**
 * 带兜底的取路径：
 * 先按"摘掉扩展名"的 file_id 试；如果失败，再用完整名字试一次。
 * 这样即使某个 file_id 本身以 .jpg/.mov 结尾（极罕见），也不会取不到。
 */
async function resolveFilePath(env, fileId, rawName, fetchImpl) {
  const first = await getFilePath(env, fileId, fetchImpl);
  if (first.ok) return first;
  if (String(rawName) !== String(fileId)) {
    const second = await getFilePath(env, rawName, fetchImpl);
    if (second.ok) return second;
  }
  return first;
}

// 访问日志：参数化写入（不再把 URL 拼进 SQL）
async function insertTgImgLog(DB, url, referer, ip, time) {
  await DB.prepare('INSERT INTO tgimglog (url, referer, ip, time) VALUES (?, ?, ?, ?)')
    .bind(url, referer, ip, time)
    .run();
}

// 取鉴黄等级（参数化查询）
async function getRating(DB, url) {
  const ps = DB.prepare('SELECT rating FROM imginfo WHERE url = ?').bind(url);
  const result = await ps.first();
  return result ? result.rating : null;
}

// 记一次访问。写库失败不该影响图片返回，但也不能像原来那样静默吞掉。
async function logRequest(env, fileId, referer, ip) {
  if (!env.IMG) return;
  try {
    const nowTime = nowTimeString();
    await insertTgImgLog(env.IMG, `/cfile/${fileId}`, referer, ip, nowTime);
    // 注意：这里必须是 /cfile/ —— 插入时用的就是这个前缀。
    // 原代码写的是 /rfile/，前缀对不上，所以这条 UPDATE 永远匹配不到任何行，
    // 后台里的"访问次数"会一直停在 1。
    await env.IMG.prepare('UPDATE imginfo SET total = total + 1 WHERE url = ?')
      .bind(`/cfile/${fileId}`)
      .run();
  } catch (error) {
    console.error('Error logging request:', error && error.message);
  }
}

/**
 * 分发一张图片/文件。
 *
 * @param {object}   o
 * @param {Request}  o.request
 * @param {object}   o.env       Cloudflare 绑定（TG_BOT_TOKEN / TG_CHAT_ID / IMG ...）
 * @param {object}   o.ctx       执行上下文（用来 waitUntil 写缓存）
 * @param {string}   o.name      路径里的原始片段，可能是 file_id 也可能是 file_id.jpg
 * @param {Function} [o.fetchImpl] 仅测试用
 * @param {object}   [o.cachesImpl] 仅测试用
 */
export async function serveTgImage({ request, env, ctx, name, fetchImpl = fetch, cachesImpl = null }) {
  const cacheStore = cachesImpl || (typeof caches !== 'undefined' ? caches.default : null);

  if (!env.TG_BOT_TOKEN || !env.TG_CHAT_ID) {
    return jsonError('TG_BOT_TOKEN or TG_CHAT_ID is not Set', 500);
  }

  const reqUrl = new URL(request.url);
  const origin = reqUrl.origin;

  // 链接里带的是 Telegram 的 file_id（可能被我们追加了一个装饰用的 .jpg）
  const { fileId, ext } = splitExt(name);
  const rawName = String(name);

  const ip = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip');
  const clientIp = ip ? ip.split(',')[0].trim() : 'IP not found';
  const referer = request.headers.get('Referer') || 'Referer';

  // ===== 第 0 步：防盗链（默认关闭）=====
  // 被拦时**不能**写缓存，否则一次误判会长期生效。
  const hot = hotlinkDecision(env, origin, referer);
  if (hot.blocked) {
    return new Response('本站图片不允许被外站直接引用。', {
      status: 403,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }

  const cacheKey = new Request(reqUrl.toString(), request);

  // ===== 第 1 步：先查边缘缓存 =====
  // 命中就直接返回，既不用查数据库，也不用把整个文件读进内存。
  // （原逻辑是"先查库再查缓存"，命中缓存也白打一次 D1 读。）
  if (cacheStore) {
    const cached = await cacheStore.match(cacheKey);
    if (cached) {
      if (!isInternalReferer(origin, referer)) {
        await logRequest(env, fileId, referer, clientIp);
      }
      return cached;
    }
  }

  // ===== 第 2 步：缓存没命中，才判断要不要拦（鉴黄）=====
  if (env.IMG) {
    let rating = null;
    try {
      rating = await getRating(env.IMG, `/cfile/${fileId}`);
    } catch (error) {
      console.error('getRating error:', error && error.message);
    }
    // rating 3 = 判定为不良内容
    if (rating === 3 && !isInternalReferer(origin, referer)) {
      await logRequest(env, fileId, referer, clientIp);
      return Response.redirect(`${origin}/img/blocked.png`, 302);
    }
  }

  // ===== 第 3 步：回源取文件 =====
  const fileResult = await resolveFilePath(env, fileId, rawName, fetchImpl);
  if (!fileResult.ok) {
    return jsonError(`无法从 Telegram 取到该文件：${fileResult.error}`, 502);
  }

  const fileName = String(fileResult.path).split('/').pop();
  // Content-Type 优先用链接里的扩展名（这正是"带扩展名"的意义：
  // 让不支持嗅探的编辑器也能正确识别），没有才回退到按文件名猜。
  const contentType = ext ? getContentType(`x.${ext}`) : getContentType(fileName);

  // 只带 User-Agent 回源。
  // 原逻辑把客户端的 request.headers 原样转发（含 Range、If-None-Match），
  // 一旦 Telegram 回 206 或 304，就会被当成 200 的完整响应包回去，内容对不上。
  const res = await fetchImpl(`https://api.telegram.org/file/bot${env.TG_BOT_TOKEN}/${fileResult.path}`, {
    method: 'GET',
    headers: { 'User-Agent': UA }
  });

  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 300);
    } catch (e) { /* 忽略 */ }
    return jsonError(`Telegram 返回 HTTP ${res.status}${detail ? '：' + detail : ''}`, 502);
  }

  const fileBuffer = await res.arrayBuffer();

  const responseImg = new Response(fileBuffer, {
    headers: {
      'Content-Type': contentType,
      // inline：让链接在浏览器里直接"显示"，而不是触发下载。
      // （原来是 attachment，所以把链接发给人、对方点开是下载文件而不是看图。）
      'Content-Disposition': `inline; filename="${String(fileName).replace(/"/g, '')}"`,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': IMG_CACHE_CONTROL,
      // 禁止浏览器"猜"内容类型，和上面在 MIME 表里去掉 svg/html 一起防 XSS
      'X-Content-Type-Options': 'nosniff'
    }
  });

  if (cacheStore && ctx && typeof ctx.waitUntil === 'function') {
    try {
      ctx.waitUntil(cacheStore.put(cacheKey, responseImg.clone()));
    } catch (e) {
      console.error('cache put failed:', e && e.message);
    }
  }

  if (isInternalReferer(origin, referer) || !env.IMG) {
    return responseImg;
  }

  await logRequest(env, fileId, referer, clientIp);
  return responseImg;
}

/**
 * 清掉某张图在边缘缓存里的所有副本。
 * 删除图片时必须调用，否则"删了但还能打开"会持续到缓存自然过期（最长 7 天）。
 *
 * 注意：同一个 file_id 可能被缓存成好几个不同的 key
 * （/i/xxx.jpg、/i/xxx、/api/cfile/xxx ...），而删除时我们通常**不知道**
 * 当初用的是哪个扩展名，所以默认把所有已知扩展名都扫一遍。
 */
export async function purgeFileCache(origin, fileId, exts, cachesImpl = null) {
  const cacheStore = cachesImpl || (typeof caches !== 'undefined' ? caches.default : null);
  if (!cacheStore) return { supported: false, purged: [] };

  let extList;
  if (Array.isArray(exts)) extList = exts.slice();
  else if (exts) extList = [exts];
  else extList = ['', ...KNOWN_EXTS];   // 未指定 → 全扫

  const urls = [];
  for (const e of extList) urls.push(`${origin}/i/${fileId}${e ? '.' + e : ''}`);
  urls.push(`${origin}/api/cfile/${fileId}`);

  const uniq = urls.filter((v, i, a) => a.indexOf(v) === i);

  const purged = [];
  for (const u of uniq) {
    try {
      const ok = await cacheStore.delete(new Request(u, { method: 'GET' }));
      purged.push({ url: u, ok: !!ok });
    } catch (e) {
      purged.push({ url: u, ok: false, error: e && e.message });
    }
  }
  return { supported: true, purged };
}
