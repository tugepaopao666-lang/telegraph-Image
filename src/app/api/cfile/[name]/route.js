export const runtime = 'edge';
import { getRequestContext } from '@cloudflare/next-on-pages';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400', // 24 hours
  'Content-Type': 'application/json'
};

const UA = " Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36 Edg/121.0.0.0";

// 缓存策略（想调整只改这一行）：
//   max-age  → 访客浏览器缓存 1 天
//   s-maxage → Cloudflare 边缘缓存 7 天
// 图片内容是"不可变"的（链接里的 file_id 就等于文件本身），所以缓存越久越快、越省流量。
// 唯一的代价是：万一需要紧急下架某张图，边缘那份最多会多留 s-maxage 那么久。
// 想立刻生效，可以到 Cloudflare 后台 Purge 掉那个 URL。
const IMG_CACHE_CONTROL = 'public, max-age=86400, s-maxage=604800';

// 注意：这里刻意去掉了 svg 和 html 两种类型。
// 它们都能内嵌 <script>，一旦有人直接打开上传的文件，脚本就会跑在本站域名下
// （和你管理后台同源），属于存储型 XSS。配合下面的 X-Content-Type-Options 双保险。
function getContentType(fileName) {
  const extension = String(fileName).split('.').pop().toLowerCase();
  const mimeTypes = {
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'png': 'image/png',
    'gif': 'image/gif',
    'bmp': 'image/bmp',
    'webp': 'image/webp',
    'pdf': 'application/pdf',
    'txt': 'text/plain',
    'json': 'application/json',
    'mp4': 'video/mp4',
    'avi': 'video/x-msvideo',
    'mov': 'video/quicktime',
    'wmv': 'video/x-ms-wmv',
    'flv': 'video/x-flv',
    'mkv': 'video/x-matroska'
  };
  return mimeTypes[extension] || 'application/octet-stream';
}


export async function OPTIONS(request) {
  return new Response(null, {
    headers: corsHeaders
  });
}

// 管理后台/列表页自己的访问不算"外部访问"，不记日志、也不拦鉴黄
function isInternalReferer(origin, referer) {
  return referer === `${origin}/admin` || referer === `${origin}/list` || referer === `${origin}/`;
}

function jsonError(message, status) {
  return Response.json(
    { status, message, success: false },
    { status, headers: corsHeaders }
  );
}


export async function GET(request, { params }) {
  const { name } = params
  const { env, ctx } = getRequestContext();

  let req_url = new URL(request.url);

  if (!env.TG_BOT_TOKEN || !env.TG_CHAT_ID) {
    return jsonError('TG_BOT_TOKEN or TG_CHAT_ID is not Set', 500);
  }

  const ip = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip');
  const clientIp = ip ? ip.split(',')[0].trim() : 'IP not found';
  const Referer = request.headers.get('Referer') || "Referer";

  // 链接里带的是 Telegram 的 file_id，不是文件名
  const fileId = name;
  const dbUrl = `/cfile/${fileId}`;

  const cacheKey = new Request(req_url.toString(), request);
  const cache = caches.default;

  // ===== 第 1 步：先查边缘缓存 =====
  // 命中就直接返回，既不用查数据库，也不用把文件读进内存。
  // （原逻辑是"先查库再查缓存"，导致哪怕命中缓存也白打一次 D1 读。）
  let cachedResponse = await cache.match(cacheKey);
  if (cachedResponse) {
    if (!isInternalReferer(req_url.origin, Referer)) {
      await logRequest(env, fileId, Referer, clientIp);
    }
    return cachedResponse;
  }

  // ===== 第 2 步：缓存没命中，才判断要不要拦（鉴黄）=====
  // 用 env.IMG 包一层：没绑 D1 时不再无谓地抛错刷日志。
  if (env.IMG) {
    let rating = null;
    try {
      rating = await getRating(env.IMG, dbUrl);
    } catch (error) {
      console.error('getRating error:', error && error.message);
    }
    if (rating === 3 && !isInternalReferer(req_url.origin, Referer)) {
      await logRequest(env, fileId, Referer, clientIp);
      return Response.redirect(`${req_url.origin}/img/blocked.png`, 302);
    }
  }

  // ===== 第 3 步：回源取文件 =====
  const fileResult = await getFile_path(env, fileId);
  if (!fileResult.ok) {
    // 原来这里引用了一个并不存在的 error 变量，会再抛一次 ReferenceError，
    // 把真正的失败原因（文件已被删、file_id 失效）彻底盖住。现在如实返回。
    return jsonError(`无法从 Telegram 取到该文件：${fileResult.error}`, 502);
  }

  const fileName = fileResult.path.split('/').pop();
  const contentType = getContentType(fileName);

  // 只带 User-Agent 去回源。
  // 原逻辑把客户端的 request.headers 原样转发（含 Range、If-None-Match 等），
  // 一旦 Telegram 回了 206 或 304，就会被当成 200 的完整响应包回去，内容对不上。
  const res = await fetch(`https://api.telegram.org/file/bot${env.TG_BOT_TOKEN}/${fileResult.path}`, {
    method: 'GET',
    headers: {
      "User-Agent": UA
    },
  });

  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 300);
    } catch (e) { }
    return jsonError(`Telegram 返回 HTTP ${res.status}${detail ? '：' + detail : ''}`, 502);
  }

  const fileBuffer = await res.arrayBuffer();

  const response_img = new Response(fileBuffer, {
    headers: {
      "Content-Type": contentType,
      // inline：让这个链接在浏览器里直接"显示图片"，而不是触发下载。
      // （原来是 attachment，所以把链接发给人、对方点开是下载文件而不是看图。）
      "Content-Disposition": `inline; filename="${fileName.replace(/"/g, '')}"`,
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": IMG_CACHE_CONTROL,
      // 禁止浏览器"猜"内容类型，和上面去掉 svg/html 一起防 XSS
      "X-Content-Type-Options": "nosniff"
    }
  });

  ctx.waitUntil(cache.put(cacheKey, response_img.clone()));

  if (isInternalReferer(req_url.origin, Referer) || !env.IMG) {
    return response_img;
  }

  await logRequest(env, fileId, Referer, clientIp);
  return response_img;
}


async function getFile_path(env, file_id) {
  try {
    const url = `https://api.telegram.org/bot${env.TG_BOT_TOKEN}/getFile?file_id=${encodeURIComponent(file_id)}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        "User-Agent": UA
      },
    })

    let responseData = await res.json();

    if (responseData.ok && responseData.result && responseData.result.file_path) {
      return { ok: true, path: responseData.result.file_path };
    }
    // 把 Telegram 给的说明带出去，别再返回一个光秃秃的 "error"
    return { ok: false, error: responseData.description || `getFile 失败（HTTP ${res.status}）` };
  } catch (error) {
    return { ok: false, error: error && error.message ? error.message : 'getFile 请求异常' };
  }
}


// 插入访问日志（参数化写入：不再把 URL 拼进 SQL）
async function insertTgImgLog(DB, url, referer, ip, time) {
  await DB.prepare('INSERT INTO tgimglog (url, referer, ip, time) VALUES (?, ?, ?, ?)')
    .bind(url, referer, ip, time)
    .run();
}


// 从数据库取鉴黄等级（参数化查询）
async function getRating(DB, url) {
  const ps = DB.prepare('SELECT rating FROM imginfo WHERE url = ?').bind(url);
  const result = await ps.first();
  return result ? result.rating : null;
}


async function get_nowTime() {
  const options = {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  };
  const timedata = new Date();
  const formattedDate = new Intl.DateTimeFormat('zh-CN', options).format(timedata);

  return formattedDate

}


// 异步日志记录
async function logRequest(env, name, referer, ip) {
  if (!env.IMG) return;
  try {
    const nowTime = await get_nowTime()
    await insertTgImgLog(env.IMG, `/cfile/${name}`, referer, ip, nowTime);
    // 注意：这里必须是 /cfile/ —— 插入时用的就是这个前缀。
    // 原代码写的是 /rfile/，前缀对不上，所以这条 UPDATE 永远匹配不到任何行，
    // 后台里的"访问次数"会一直停在 1（插入时的初始值）。
    await env.IMG.prepare('UPDATE imginfo SET total = total + 1 WHERE url = ?')
      .bind(`/cfile/${name}`)
      .run();
  } catch (error) {
    console.error('Error logging request:', error && error.message);
  }
}
