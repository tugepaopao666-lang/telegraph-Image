// ============================================================================
// src/lib/tg-common.js
// 共享常量与纯函数。
//
// 设计约束：本文件**刻意不 import 任何 Cloudflare / Next 专有模块**，
// 因此可以被 node 直接加载做单元测试（见项目里的 tests/ 目录）。
// 所有需要 env / 网络的能力都由调用方通过参数传进来。
// ============================================================================

// 统一带上的 User-Agent。Telegram 对空 UA 偶尔会拒，带上更稳。
// （注意开头那个空格是原项目就有的，保持原样，避免无谓的 diff。）
export const UA = " Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36 Edg/121.0.0.0";

// Telegram 的硬性上限，超了必定被拒。
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;   // sendPhoto：10MB
export const MAX_OTHER_BYTES = 50 * 1024 * 1024;   // sendVideo / sendAudio / sendDocument：50MB

// 图片内容的缓存策略：
//   max-age  → 访客浏览器缓存 1 天
//   s-maxage → Cloudflare 边缘缓存 7 天
// 想立刻生效（例如紧急下架），到 Cloudflare 后台 Purge 掉那个 URL，或用 /del 命令。
export const IMG_CACHE_CONTROL = 'public, max-age=86400, s-maxage=604800';

// Telegram caption 上限 1024 字符（兜底文案要截断）
export const CAPTION_LIMIT = 1024;

// ---------------------------------------------------------------------------
// 扩展名 / MIME
// ---------------------------------------------------------------------------
// ⚠️ 刻意**不含** svg 和 html：它们都能内嵌 <script>，一旦有人直接打开上传的
//    文件，脚本就会跑在你图床的域名下（和后台同源）—— 属于存储型 XSS。
//    配合响应头里的 X-Content-Type-Options: nosniff 做双保险。
const EXT_TO_MIME = {
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
  'mkv': 'video/x-matroska',
  'mp3': 'audio/mpeg',
  'm4a': 'audio/mp4',
  'ogg': 'audio/ogg',
  'wav': 'audio/wav'
};

// 只有白名单里的扩展名才会被 /i/xxx.jpg 这种链接"摘掉"。
// 这样即使某个 Telegram file_id 结尾恰好长得像扩展名，也不会被误切。
export const KNOWN_EXTS = Object.keys(EXT_TO_MIME);

export function getContentType(fileName) {
  const ext = String(fileName || '').split('.').pop().toLowerCase();
  return EXT_TO_MIME[ext] || 'application/octet-stream';
}

// 把上传时的 MIME 映射成给链接用的扩展名（拿不准就返回空串，链接就不带扩展名）
export function mimeToExt(mime) {
  if (!mime) return '';
  const m = String(mime).toLowerCase().split(';')[0].trim();
  if (m === 'image/jpeg' || m === 'image/jpg' || m === 'image/pjpeg') return 'jpg';
  if (m === 'image/png') return 'png';
  if (m === 'image/gif') return 'gif';
  if (m === 'image/webp') return 'webp';
  if (m === 'image/bmp') return 'bmp';
  if (m === 'application/pdf') return 'pdf';
  if (m === 'video/mp4') return 'mp4';
  if (m === 'video/quicktime') return 'mov';
  if (m === 'video/x-msvideo') return 'avi';
  if (m === 'video/x-ms-wmv') return 'wmv';
  if (m === 'video/x-flv') return 'flv';
  if (m === 'video/x-matroska') return 'mkv';
  if (m.startsWith('video/')) return 'mp4';
  if (m === 'audio/mpeg') return 'mp3';
  if (m === 'audio/mp4') return 'm4a';
  if (m === 'audio/ogg') return 'ogg';
  if (m === 'audio/wav' || m === 'audio/x-wav') return 'wav';
  if (m.startsWith('audio/')) return 'mp3';
  if (m === 'text/plain') return 'txt';
  return '';
}

/**
 * 把一个路径片段拆成 { fileId, ext }。
 * 只有当结尾的扩展名在白名单里时才认为是"装饰用的扩展名"。
 * 例：'AgADxxx.jpg' → { fileId: 'AgADxxx', ext: 'jpg' }
 *     'AgADxxx'     → { fileId: 'AgADxxx', ext: '' }
 *     'AgADxxx.mov' → { fileId: 'AgADxxx', ext: 'mov' }
 *     但 'AgADxxx.zzz' → { fileId: 'AgADxxx.zzz', ext: '' }（白名单外，原样保留）
 */
export function splitExt(name) {
  const s = String(name == null ? '' : name);
  const i = s.lastIndexOf('.');
  if (i <= 0 || i === s.length - 1) return { fileId: s, ext: '' };
  const ext = s.slice(i + 1).toLowerCase();
  if (!KNOWN_EXTS.includes(ext)) return { fileId: s, ext: '' };
  return { fileId: s.slice(0, i), ext };
}

/**
 * 把用户随手粘贴的东西解析成 file_id。
 * 支持：完整链接 / /i/xxx.jpg / /api/cfile/xxx / 纯 file_id
 */
export function parseFileRef(raw) {
  let s = String(raw == null ? '' : raw).trim();
  if (!s) return { fileId: '', ext: '' };
  s = s.replace(/^https?:\/\/[^/]+/i, '');   // 去掉协议+域名
  s = s.replace(/[?#].*$/, '');              // 去掉查询串和锚点
  s = s.replace(/^\/?(?:api\/)?(?:cfile|rfile|file|i)\//i, ''); // 去掉路由前缀
  s = s.replace(/^\/+/, '');
  return splitExt(s);
}

// ---------------------------------------------------------------------------
// 链接与按钮
// ---------------------------------------------------------------------------

/**
 * 生成对外使用的短链：`<origin>/i/<file_id>.<ext>`
 * 带扩展名很重要 —— 很多编辑器/平台要求图片 URL 必须以 .jpg/.png 结尾，
 * 否则会拒收或不显示。
 */
export function shortLink(origin, fileId, mime) {
  const ext = mimeToExt(mime);
  return `${origin}/i/${fileId}${ext ? '.' + ext : ''}`;
}

export function linkFormats(url) {
  return {
    direct: url,
    html: '<img src="' + url + '">',
    markdown: '![图片](' + url + ')',
    bbcode: '[img]' + url + '[/img]'
  };
}

/**
 * 频道里图片下方挂的按钮键盘。
 *
 * 布局（3 行）：
 *   🔍 打开图片              ← 新增的 url 按钮，点一下直接看图（对不熟悉的人最友好）
 *   图片直链 | HTML          ← 以下都是 copy_text 按钮，点一下复制到剪贴板
 *   Markdown | BBCode
 *
 * ⚠️ Telegram 规定：一个按钮只能**二选一**（要么 url 要么 copy_text），
 *    所以「打开图片」是**新增一个按钮**，不是改造原来那四个。
 */
export function buildKeyboard(shortUrl) {
  const f = linkFormats(shortUrl);
  return {
    inline_keyboard: [
      [
        { text: '🔍 打开图片', url: shortUrl }
      ],
      [
        { text: '图片直链', copy_text: { text: f.direct } },
        { text: 'HTML', copy_text: { text: f.html } }
      ],
      [
        { text: 'Markdown', copy_text: { text: f.markdown } },
        { text: 'BBCode', copy_text: { text: f.bbcode } }
      ]
    ]
  };
}

/** 挂按钮失败时的兜底：四种格式全部写进说明文字（超过上限就截断） */
export function buildCaption(shortUrl) {
  const f = linkFormats(shortUrl);
  let caption = '图片直链：\n' + f.direct +
    '\n\nHTML：\n' + f.html +
    '\n\nMarkdown：\n' + f.markdown +
    '\n\nBBCode：\n' + f.bbcode;
  if (caption.length > CAPTION_LIMIT) {
    caption = caption.slice(0, CAPTION_LIMIT - 1) + '…';
  }
  return caption;
}

// ---------------------------------------------------------------------------
// 杂项
// ---------------------------------------------------------------------------

export function humanSize(bytes) {
  if (typeof bytes !== 'number' || !isFinite(bytes) || bytes <= 0) return '未知大小';
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return bytes + ' B';
}

export function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** 存进数据库、给后台显示用的本地时间字符串（与项目原有格式保持一致） */
export function nowTimeString(date = new Date()) {
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
  return new Intl.DateTimeFormat('zh-CN', options).format(date);
}

/** ISO 时间：只用于我们自己新增的表（tgmsg / botstate），不污染原有列 */
export function isoNow(date = new Date()) {
  return date.toISOString();
}

/** Asia/Shanghai 的日期串 YYYY-MM-DD —— 用来判断"今天是否已经播报过" */
export function shanghaiDate(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date);
}

/** 从频道消息里取出 file_id（图片取最大的那档） */
export function extractFileIdFromPost(post) {
  if (!post) return null;
  if (Array.isArray(post.photo) && post.photo.length) {
    const largest = post.photo.reduce((prev, cur) =>
      ((prev.file_size || 0) > (cur.file_size || 0)) ? prev : cur);
    return largest && largest.file_id ? largest.file_id : null;
  }
  const keys = ['video', 'animation', 'audio', 'document', 'voice'];
  for (const k of keys) {
    if (post[k] && post[k].file_id) return post[k].file_id;
  }
  return null;
}

export function kindOfPost(post) {
  if (!post) return 'unknown';
  if (Array.isArray(post.photo) && post.photo.length) return 'photo';
  const keys = ['video', 'animation', 'audio', 'document', 'voice'];
  for (const k of keys) if (post[k]) return k;
  return 'text';
}

/** 把 file_id 还原成数据库里用的 url 形式（与现有代码保持一致） */
export function dbUrlOf(fileId) {
  return `/cfile/${fileId}`;
}

/**
 * 请求是不是"站内自己人"的访问。
 * 后台/列表页自己加载图片不算"外部访问"：不记日志、也不拦鉴黄。
 */
export function isInternalReferer(origin, referer) {
  return referer === `${origin}/admin` ||
    referer === `${origin}/list` ||
    referer === `${origin}/`;
}

/**
 * 防盗链判定（默认**关闭**，只有显式设置 HOTLINK_PROTECT=true 才生效）。
 *
 * 刻意做了几条放行，避免误伤正常使用：
 *   - 没有 Referer（直接打开链接、从微信/QQ 点开、粘贴到地址栏）→ 放行
 *   - 站内来源 → 放行
 *   - 没配白名单 → 放行（宁可不拦，也不要把站搞坏）
 */
export function hotlinkDecision(env, origin, referer) {
  const mode = String((env && env.HOTLINK_PROTECT) || '').toLowerCase();
  if (!['true', '1', 'on', 'yes'].includes(mode)) return { blocked: false, reason: 'off' };

  if (!referer || referer === 'Referer') return { blocked: false, reason: 'no-referer' };
  if (isInternalReferer(origin, referer)) return { blocked: false, reason: 'internal' };

  const allow = String((env && env.HOTLINK_ALLOW) || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (!allow.length) return { blocked: false, reason: 'no-allowlist' };

  let host = '';
  try {
    host = new URL(referer).hostname.toLowerCase();
  } catch (e) {
    return { blocked: false, reason: 'bad-referer' };
  }

  const hit = allow.some(d => host === d || host.endsWith('.' + d));
  return hit ? { blocked: false, reason: 'allowlisted' } : { blocked: true, reason: 'not-allowlisted' };
}

/** CSV 单元格转义 */
export function csvCell(v) {
  const s = v == null ? '' : String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

export function toCsv(rows) {
  return rows.map(r => r.map(csvCell).join(',')).join('\r\n');
}
