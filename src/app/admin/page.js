'use client'
import { signOut } from "next-auth/react"
import Table from "@/components/Table"
import { useState, useEffect, useCallback } from 'react';
import { ToastContainer, toast } from "react-toastify";
import Link from 'next/link'

// ============================================================================
// src/app/admin/page.js —— 后台首页
//
// ⚠️ 2026-09-19 改动（在原版基础上）：
//   ① 新增「排序」下拉框：最新优先（默认）/ 最早优先 / 访问最多 / 访问最少 / 鉴黄等级高→低。
//      排序在服务端做（接口支持 sort/dir），所以是对**全部记录**排序，不是只排当前这一页。
//   ② 切换排序时自动回到第 1 页（否则会停在一个页号上看到奇怪的结果）。
//   ③ 搜索框改成**手机上也能用**（原版是 `hidden sm:flex`，手机上看不到搜索）。
//
// 说明：搜索和分页**本来就有**（原版就有），这次只是补上排序、并把搜索放到手机上。
// ============================================================================

const SORT_OPTIONS = [
  { key: 'id-desc', label: '最新优先', sort: 'id', dir: 'desc' },
  { key: 'id-asc', label: '最早优先', sort: 'id', dir: 'asc' },
  { key: 'total-desc', label: '访问最多', sort: 'total', dir: 'desc' },
  { key: 'total-asc', label: '访问最少', sort: 'total', dir: 'asc' },
  { key: 'rating-desc', label: '鉴黄等级高→低', sort: 'rating', dir: 'desc' }
];



export default function Admin() {
  const [listData, setListData] = useState([])
  const [currentPage, setCurrentPage] = useState(1);
  const [searchTotal, setSearchTotal] = useState(0); // 初始化为0，因为初始时还没有搜索结果
  const [inputPage, setInputPage] = useState(1);
  const [view, setView] = useState('list'); // 'list' 或 'log'，默认为 'list'
  const [searchQuery, setSearchQuery] = useState('');
  // ---- 2026-09-19 新增：排序 ----
  const [sortKey, setSortKey] = useState('id-desc');



  const getListdata = useCallback(async (page) => {
    const opt = SORT_OPTIONS.find((o) => o.key === sortKey) || SORT_OPTIONS[0];
    try {
      const res = await fetch(`/api/admin/${view}`, {
        method: "POST",
        headers: {
          'Content-Type': 'application/json',
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36",
        },
        body: JSON.stringify({
          page: (page - 1),
          query: searchQuery, // 传递搜索查询
          sort: opt.sort,     // 2026-09-19 新增
          dir: opt.dir        // 2026-09-19 新增
        })
      })
      const res_data = await res.json()
      if (!res_data?.success) {
        toast.error(res_data.message)
      } else {
        setListData(res_data.data)
        const totalPages = Math.ceil(res_data.total / 10);
        setSearchTotal(totalPages || 1);
      }

    } catch (error) {
      toast.error(error.message)
    }

  })


  useEffect(() => {
    getListdata(currentPage)
  }, [currentPage, view, sortKey]);

  // 分页控制按钮
  const handleNextPage = () => {
    const nextPage = currentPage + 1;
    if (nextPage > searchTotal) { // 检查下一页是否在总页数范围内
      toast.error('当前已为最后一页！')
    }
    if (nextPage <= searchTotal) { // 检查下一页是否在总页数范围内
      setCurrentPage(nextPage);
      setInputPage(nextPage)
    }

  };

  const handlePrevPage = () => {
    const prevPage = currentPage - 1;
    if (prevPage >= 1) { // 检查上一页是否在总页数范围内
      setCurrentPage(prevPage);
      setInputPage(prevPage)
      // searchVideo(prevPage);
    }

  };


  const handleJumpPage = () => {
    const page = parseInt(inputPage, 10);
    if (!isNaN(page) && page >= 1 && page <= searchTotal) {
      setCurrentPage(page);
    } else {
      toast.error('请输入有效的页码！');
    }
    // setInputPage(""); // 清空输入框
  };

  const handleViewToggle = () => {
    setView(view === 'list' ? 'log' : 'list');
    setCurrentPage(1); // 切换视图时重置到第一页
    setInputPage(1);
  };


  const handleSearch = (event) => {
    event.preventDefault();
    setCurrentPage(1);
    setInputPage(1);
    getListdata(1);
  };

  /** 换排序方式：回第 1 页再拉 —— 2026-09-19 新增 */
  const handleSortChange = (e) => {
    setSortKey(e.target.value);
    setCurrentPage(1);
    setInputPage(1);
  };

  return (
    <>
      <div className="overflow-auto h-full flex w-full min-h-screen flex-col items-center justify-between">
        <header className="fixed top-0 min-h-[50px] left-0 w-full border-b bg-white flex z-50 flex-wrap justify-center items-center gap-2 py-1">
          <div className="flex flex-wrap justify-center items-center w-full max-w-4xl px-2 gap-2">
            <button className='text-white px-3 py-2 text-sm transition ease-in-out delay-150 bg-blue-500 hover:scale-110 hover:bg-indigo-500 duration-300  rounded '
              onClick={handleViewToggle}>
              切换到 {view === 'list' ? '日志页' : '数据页'}
            </button>
            {/* 2026-09-19：搜索框改成手机上也能用 */}
            <form onSubmit={handleSearch} className="flex items-center">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="border rounded p-2 w-32 sm:w-40 mr-2 text-sm"
                placeholder="搜索链接"
              />
              <button type="submit" className="text-white px-3 py-2 text-sm transition ease-in-out delay-150 bg-blue-500 hover:scale-110 hover:bg-indigo-500 duration-300 rounded">
                搜索
              </button>
            </form>
            {/* 2026-09-19 新增：排序下拉 */}
            <label className="flex items-center text-sm text-gray-600">
              排序
              <select
                value={sortKey}
                onChange={handleSortChange}
                className="ml-2 border rounded p-2 text-sm bg-white"
              >
                {SORT_OPTIONS.map((o) => (
                  <option key={o.key} value={o.key}>{o.label}</option>
                ))}
              </select>
            </label>
          </div>
          <Link href="/" className="hidden sm:flex"> <button className="px-4 py-2 mx-2 w-28  sm:w-28 md:w-20 lg:w-16 xl:w-16  2xl:w-20 bg-blue-500 text-white rounded ">主页</button></Link>
          <button onClick={() => signOut({ callbackUrl: "/" })} className="px-4 py-2 mx-2 w-28  sm:w-28 md:w-20 lg:w-16 xl:w-16  2xl:w-20 bg-blue-500 text-white rounded ">登出</button>
        </header>

        <main className="my-[70px] w-9/10  sm:w-9/10 md:w-9/10 lg:w-9/10 xl:w-3/5 2xl:w-full">

          <Table data={listData} />

        </main>
        <div className="fixed inset-x-0 bottom-0 h-[50px]  w-full  flex  z-50 justify-center items-center bg-white ">
          <div className="pagination mt-5 mb-5 flex justify-center items-center">
            <button className=' text-xs sm:text-sm transition ease-in-out delay-150 bg-blue-500  hover:scale-110 hover:bg-indigo-500 duration-300p-2 p-2 rounded mr-5' onClick={handlePrevPage} disabled={currentPage === 1}>
              上一页
            </button>
            <span className="text-xs sm:text-sm">第 {`${currentPage}/${searchTotal}`} 页</span>
            <button className='text-xs sm:text-sm transition ease-in-out delay-150 bg-blue-500  hover:scale-110 hover:bg-indigo-500 duration-300 p-2 rounded ml-5' onClick={handleNextPage}>
              下一页</button>
            <div className="ml-5 flex items-center">
              <input
                type="number"
                value={inputPage}
                onChange={(e) => setInputPage(e.target.value)}
                className="border rounded p-2 w-20"
                placeholder="页码"
              />
              <button className='text-xs sm:text-sm transition ease-in-out delay-150 bg-blue-500 hover:scale-110 hover:bg-indigo-500 duration-300 p-2 rounded ml-2' onClick={handleJumpPage}>
                跳转
              </button>
            </div>
          </div>
        </div>
        <ToastContainer />
      </div>
    </>

  )
}
