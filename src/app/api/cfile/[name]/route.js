// ============================================================================
// src/app/api/cfile/[name]/route.js
//
// 老链接入口：/api/cfile/<file_id>
// 为了兼容已经发出去的链接，这个路径必须一直存在。
//
// 真正的实现已抽到 src/lib/tg-serve.js —— 本文件只是一层薄壳，
// 和 src/app/i/[name]/route.js 共用同一份逻辑，避免"改了 A 忘了 B"。
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
