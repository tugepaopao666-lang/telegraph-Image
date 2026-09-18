// ============================================================================
// src/app/api/total/route.js
//
// 首页那句「本站已托管 N 张图片」就是走这里 —— 一条 COUNT(*)，只读、不写库。
//
// --- 2026-09-18 清洁记录 ---------------------------------------------------
// 删掉了文件末尾那段 `insertImageData()`。它是从上游带过来的**死代码**：
//   没有 export、也没有任何地方调用它（本文件唯一的 GET 只执行下面那条
//   SELECT COUNT(*)）。但它内部是「字符串拼接 SQL + catch 里什么都不做」，
//   是会被安全审计误判成真漏洞的写法 —— 既然不可达，直接删掉最省心。
//
// 顺带删掉三处同样没用到的东西（都不影响行为）：
//   · import { NextResponse } from "next/server"
//   · import { headers } from 'next/headers'
//   · GET 里那个从没被用过的 `totalImg`
//
// ⚠️ 行为完全不变：仍然是「绑了 D1 就返回图片总数，没绑就返回 ?」。
// ============================================================================

import { getRequestContext } from '@cloudflare/next-on-pages';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400', // 24 hours
  'Content-Type': 'application/json'
};

export const runtime = 'edge';

export async function GET(request) {
  // 取 Cloudflare 运行时上下文；D1 绑定在 env.IMG 上（绑定名必须是 IMG）
  const { env } = getRequestContext();

  try {
    if (env.IMG) {
      const total = await env.IMG.prepare(`SELECT COUNT(*) as total FROM imginfo`).first()
      return Response.json({
        "code": 200,
        "success": true,
        "message": "success",
        "total": total.total
      });
    } else {
      return Response.json({
        "code": 500,
        "success": true,
        "message": "no db",
        "total": "?"
      }, {
        status: 500,
        headers: corsHeaders,
      })
    }
  } catch (error) {
    return Response.json({
      "code": 500,
      "success": false,
      "message": error.message,
    }, {
      status: 500,
      headers: corsHeaders,
    })
  }
}

// 这里原本还有一个 insertImageData(env, src, referer, ip, rating, time)。
// 它没有被 export、也没有被任何地方调用 —— 纯粹的死代码，已于 2026-09-18 删除
// （详见文件顶部说明）。首页那个数字走的就是上面的 COUNT(*)，与它无关。
