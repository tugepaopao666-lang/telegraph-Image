// ============================================================================
// src/app/api/tgbot/route.js
//
// Telegram webhook 端点。Telegram 每次有新消息/频道消息都会 POST 到这里。
//
// 安全：setWebhook 时设了 secret_token，Telegram 会在请求头里带上
//       X-Telegram-Bot-Api-Secret-Token，这里逐字比对，不对就 403。
//
// 这个路径不在 middleware.js 的 matcher 里，所以是"公开可达"的 ——
// 安全性完全靠上面那个密钥。TG_WEBHOOK_SECRET 一定要设。
// ============================================================================

import { getRequestContext } from '@cloudflare/next-on-pages';
import { createTg, handleUpdate } from '@/lib/tg-bot';

export const runtime = 'edge';

export async function POST(request) {
  const { env, ctx } = getRequestContext();

  if (env.TG_WEBHOOK_SECRET) {
    const got = request.headers.get('x-telegram-bot-api-secret-token');
    if (got !== env.TG_WEBHOOK_SECRET) {
      return new Response('forbidden', { status: 403 });
    }
  }

  let update = null;
  try {
    update = await request.json();
  } catch (e) {
    // 不是合法 JSON，直接当成功返回，免得 Telegram 一直重试
    return Response.json({ ok: true });
  }

  const origin = new URL(request.url).origin;
  const tg = createTg({ token: env.TG_BOT_TOKEN });

  // 先把活儿挂到后台，立刻回 200。
  // Telegram 对响应慢的 webhook 会重试，重复投递虽然被我们做成幂等的，
  // 但会让同一条消息被处理两次，不如尽早返回。
  const work = handleUpdate({ update, env, tg, db: env.IMG, origin })
    .then((r) => console.log('tg update handled:', JSON.stringify(r)))
    .catch((e) => console.error('handleUpdate failed:', (e && e.stack) || e));

  if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(work);
  } else {
    await work;
  }

  return Response.json({ ok: true });
}

export async function GET() {
  return Response.json({
    ok: true,
    hint: '这是 Telegram webhook 端点，只接受 Telegram 的 POST 请求。'
  });
}
