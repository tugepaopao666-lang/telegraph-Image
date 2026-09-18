'use client';
import { useState, useEffect } from 'react';
import Link from 'next/link';
export default function Footer() {
  // 年份取访客本机时间；先给个初始值，避免服务端与浏览器渲染不一致的报错
  const [year, setYear] = useState(2026);
  useEffect(() => { setYear(new Date().getFullYear()); }, []);
  return (
    <footer className="w-full  h-1/12 text-center  bg-slate-200  flex flex-col justify-center items-center">
      <div >
        <p className="text-xs text-gray-500">Copyright Ⓒ {year} All rights reserved. 请勿上传违反中国法律的图片，违者后果自负。 本程序基于Cloudflare Pages，开源于
          <Link 
          href="https://github.com/x-dr/telegraph-Image"
          className="text-blue-300  hover:text-red-900 ml-1"
          target="_blank"
          rel="noopener noreferrer"
          >GitHub Telegraph-Image</Link> </p>
      </div>
    </footer>
  );
}
