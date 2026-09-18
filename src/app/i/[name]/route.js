// ============================================================================
// src/app/i/[name]/route.js
//
// 新短链入口：/i/<file_id>.<扩展名>
//   例：https://你的域名/i/AgADxxxxx.jpg
//
// 为什么要带扩展名：很多编辑器/平台（公众号、知乎、Notion、不少 Markdown 工具）
// 要求图片 URL 必须以 .jpg/.png 这类扩展名结尾，否则会拒收或不显示。
// 原来那种 /api/cfile/<file_id> 中间还有一个 /api 段、又没有扩展名，两边都吃亏。
//
// 扩展名只是"装饰"：真正发给 Telegram 的 file_id 会把尾巴摘掉
// （只有白名单里的扩展名才会被摘，见 src/lib/tg-common.js 的 splitExt）。
// 万一摘错了，tg-serve 还会拿完整名字再试一次，所以不会取不到图。
//
// 注意：/i/ 不在 middleware.js 的 matcher 里，所以是公开访问的 —— 和 /api/cfile/ 一致。
// ============================================================================

import { getRequestContext } from '@cloudflare/next-on-pages';
import { serveTgImage, corsPreflight } from '@/lib/tg-serve';

export const runtime = 'edge';

export async function OPTIONS() {
  return corsPreflight();
}

export async function GET(request, { params }) {
  const { env, ctx } = getRequestContext();
  const { name } = params;
  return serveTgImage({ request, env, ctx, name });
}
