import { useState, useEffect } from "react";
import Switcher from '@/components/SwitchButton';
import { toast } from "react-toastify";
import React, { useRef } from 'react';
import TooltipItem from '@/components/Tooltip';
import FullScreenIcon from "@/components/FullScreenIcon"
import { PhotoProvider, PhotoView } from 'react-photo-view';

// ============================================================================
// src/components/Table.jsx —— 后台列表
//
// ⚠️ 2026-09-19 改动（在原版基础上）：
//   ① 新增「批量删除」：每行前面加了勾选框 + 表头全选，选中的会被一次删掉
//      （调的还是 /api/admin/delete，只是多传一个 names 数组）。
//   ② 删除提示改了文案：现在是**真删**（连同频道里的图片一起删），所以明确告诉你
//      "删了找不回来"，不再是一句轻飘飘的"你确定要删除这个项目吗？"。
//   ③ 点开图片名（原来只有四种格式）的详情弹窗里，补上了**上传时间 / 访问量 /
//      来源 / IP / 鉴黄等级 / file_id**，还有一个"在新窗口打开原图"。
//      —— 这就是你要的"单图详情"，不另开一个页面：表格里本来就有这些字段，
//         做成弹窗比多一个页面更省事，也不用来回跳。
//   ④ 删除成功后的提示会带上明细（删了几条频道消息 / 清了几行库），
//      这样"删了但链接还能打开"你一眼就知道是缓存没清掉。
// ============================================================================

export default function Table({ data: initialData = [] }) {

    const [data, setData] = useState(initialData); // 初始化状态
    const [modalData, setModalData] = useState(null);
    const modalRef = useRef(null);

    // ---- 2026-09-19 新增：批量选择 ----
    const [selected, setSelected] = useState([]);
    const [batchDeleting, setBatchDeleting] = useState(false);



    useEffect(() => {
        setData(initialData); // 更新数据
        setSelected([]);      // 换页/换搜索词时清空选择（免得删到看不见的那些行）
    }, [initialData]);

    const handleClickOutside = (e) => {
        if (modalRef.current && !modalRef.current.contains(e.target)) {
            setModalData(null);
        }
    };

    const origin = typeof window !== 'undefined' ? window.location.origin : '';




    const getImgUrl = (url) => {
        return url.startsWith("/file/") || url.startsWith("/cfile/") || url.startsWith("/rfile/") ? `${origin}/api${url}` : url;
    };

    const handleNameClick = (item) => {
        setModalData(item);
    };

    const handleCloseModal = () => {
        setModalData(null);
    };



    const handleCopy = (text) => {
        navigator.clipboard.writeText(text).then(() => {
            toast.success(`链接复制成功`);
        });
    };



    /**
     * 删一条或多条：走同一个接口（多传一个 names 数组）。
     * 后端现在会**连频道里那条图片一起删**，所以调用前必须确认过。
     */
    const deleteItems = async (names) => {
        try {
            const res = await fetch(`/api/admin/delete`, {
                method: 'DELETE',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    names: names,
                }),
            });
            const res_data = await res.json();
            if (res_data && res_data.success) {
                let msg = `已删除 ${res_data.count} 条`;
                if (typeof res_data.messageDeleted === 'number') {
                    msg += `（频道里的图片删掉 ${res_data.messageDeleted} 条）`;
                }
                if (typeof res_data.dbRows === 'number') {
                    msg += `，数据库清理 ${res_data.dbRows} 行`;
                }
                toast.success(msg);
                if (res_data.notes && res_data.notes.length) {
                    toast.info(res_data.notes.slice(0, 3).join('；'), { autoClose: 8000 });
                }
                setData(prevData => prevData.filter(item => !names.includes(item.url)));
                setSelected([]);
                return true;
            }
            toast.error((res_data && res_data.message) || '删除失败');
            return false;
        } catch (error) {
            toast.error(error.message);
            return false;
        }
    };


    const handleDelete = async (initName) => {
        const confirmed = window.confirm(
            '确定要删除吗？\n\n' +
            '注意：现在会**连频道里的那张图片一起删掉**，删了找不回来。'
        );
        if (confirmed) {
            await deleteItems([initName]);
        }
    };

    /** 批量删除选中项 —— 2026-09-19 新增 */
    const handleDeleteSelected = async () => {
        if (!selected.length) return;
        const confirmed = window.confirm(
            `确定要删除选中的 ${selected.length} 条吗？\n\n` +
            '注意：会**连频道里的这些图片一起删掉**，删了找不回来。'
        );
        if (!confirmed) return;
        setBatchDeleting(true);
        try {
            await deleteItems(selected);
        } finally {
            setBatchDeleting(false);
        }
    };

    /** 勾选/取消一条 —— 2026-09-19 新增 */
    const toggleOne = (url) => {
        setSelected((prev) => prev.includes(url)
            ? prev.filter((u) => u !== url)
            : prev.concat([url]));
    };

    /** 本页是否已全选 —— 2026-09-19 新增 */
    const allSelected = data.length > 0 && data.every((it) => selected.includes(it.url));

    const toggleAll = () => {
        setSelected(allSelected ? [] : data.map((it) => it.url));
    };


    function getLastSegment(url) {
        const lastSlashIndex = url.lastIndexOf('/');
        return url.substring(lastSlashIndex + 1);
    }
    const renderFile = (fileUrl, index) => {
        const _url = getLastSegment(fileUrl);
        const getFileExtension = (url) => {
            const parts = url.split('.');
            return parts.length > 1 ? parts.pop().toLowerCase() : '';
        };
        const fileExtension = getFileExtension(_url);



        const imageExtensions = [
            'jpg', 'jpeg', 'png', 'gif', 'bmp', 'tiff', 'tif', 'webp',
            'svg', 'ico', 'heic', 'heif', 'raw', 'psd', 'ai', 'eps'
        ];

        const videoExtensions = [
            'mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'ogg',
            'ogv', 'm4v', '3gp', '3g2', 'mpg', 'mpeg', 'mxf', 'vob'
        ];

        if (imageExtensions.includes(fileExtension)) {

            return (
                <img
                    key={`image-${index}`}
                    src={fileUrl}
                    alt={`Uploaded ${index}`}
                    className="w-full h-full object-cover"
                />
            );
        }
        else if (videoExtensions.includes(fileExtension)) {
            return (
                <video
                    key={`video-${index}`}
                    src={fileUrl}
                    className="w-full h-full object-cover"
                    controls
                >
                    Your browser does not support the video tag.
                </video>
            );
        }
        else {
            return (
                <img
                    key={`image-${index}`}
                    src={fileUrl}
                    alt={`Uploaded ${index}`}
                    className="w-full h-full object-cover"
                />
            );
        }
    };

    function toggleFullScreen() {
        if (document.fullscreenElement) {
            document.exitFullscreen();
        } else {
            const element = document.querySelector('.PhotoView-Portal');
            if (element) {
                element.requestFullscreen();
            }
        }
    }

    const isVideo = (url) => {
        return /\.(mp4|mkv|avi|mov|wmv|flv|webm|ogg|ogv|m4v|3gp|3g2|mpg|mpeg|mxf|vob)$/i.test(url);
    }

    const elementSize = 400;
    return (
        <div className="mx-2">
            {/* 2026-09-19 新增：批量操作条 */}
            <div className="flex items-center gap-3 my-2 px-2 flex-wrap">
                <span className="text-sm text-gray-600">
                    本页 {data.length} 条{selected.length ? `，已选 ${selected.length} 条` : ''}
                </span>
                {selected.length > 0 && (
                    <>
                        <button
                            onClick={handleDeleteSelected}
                            disabled={batchDeleting}
                            className={`px-3 py-1 text-sm font-medium text-white rounded focus:outline-none ${batchDeleting ? 'bg-red-300 cursor-not-allowed' : 'bg-red-600 hover:bg-red-700'}`}
                        >
                            {batchDeleting ? '正在删除…' : `批量删除（${selected.length}）`}
                        </button>
                        <button
                            onClick={() => setSelected([])}
                            className="px-3 py-1 text-sm font-medium text-gray-700 bg-gray-100 rounded hover:bg-gray-200"
                        >
                            取消选择
                        </button>
                    </>
                )}
                <span className="text-xs text-gray-400">勾选左侧方框可多选；删除会连频道里的图片一起删掉</span>
            </div>
            <table className="min-w-full bg-white  items-center justify-between ">
                <thead >
                    <tr className="sticky top-0 bg-gray-100 z-20">
                        <th className=" py-2 px-4 border-b border-gray-200 bg-gray-100  text-center text-sm font-semibold text-gray-600">
                            <input
                                type="checkbox"
                                checked={allSelected}
                                onChange={toggleAll}
                                title="全选本页"
                            />
                        </th>
                        <th className=" py-2 px-4 border-b border-gray-200 bg-gray-100  text-center text-sm font-semibold text-gray-600">name</th>
                        <th className="sticky left-0 z-10 py-2 px-4 border-b border-gray-200 bg-gray-100 text-center text-sm font-semibold text-gray-600">preview</th>
                        <th className=" py-2 px-4 border-b border-gray-200 bg-gray-100  text-center text-sm font-semibold text-gray-600">time</th>
                        <th className=" py-2 px-4 border-b border-gray-200 bg-gray-100  text-center text-sm font-semibold text-gray-600">referer</th>
                        <th className=" py-2 px-4 border-b border-gray-200 bg-gray-100  text-center text-sm font-semibold text-gray-600">ip</th>
                        <th className=" py-2 px-4 border-b border-gray-200 bg-gray-100  text-center text-sm font-semibold text-gray-600">PV</th>
                        <th className=" py-2 px-4 border-b border-gray-200 bg-gray-100  text-center text-sm font-semibold text-gray-600">rating</th>
                        <th className="sticky  right-0 z-10 py-2 px-4 border-b border-gray-200 bg-gray-100  text-center text-sm font-semibold text-gray-600">限制访问</th>
                    </tr>
                </thead>
                <tbody >

                    <PhotoProvider
                        maskOpacity={0.5}
                        toolbarRender={({ rotate, onRotate, onScale, scale }) => {
                            return (
                                <>
                                    <svg
                                        className="PhotoView-Slider__toolbarIcon"
                                        width="44"
                                        height="44"
                                        viewBox="0 0 768 768"
                                        fill="white"
                                        onClick={() => onScale(scale + 0.5)}
                                    >
                                        <path d="M384 640.5q105 0 180.75-75.75t75.75-180.75-75.75-180.75-180.75-75.75-180.75 75.75-75.75 180.75 75.75 180.75 180.75 75.75zM384 64.5q132 0 225.75 93.75t93.75 225.75-93.75 225.75-225.75 93.75-225.75-93.75-93.75-225.75 93.75-225.75 225.75-93.75zM415.5 223.5v129h129v63h-129v129h-63v-129h-129v-63h129v-129h63z" />
                                    </svg>
                                    <svg
                                        className="PhotoView-Slider__toolbarIcon"
                                        width="44"
                                        height="44"
                                        viewBox="0 0 768 768"
                                        fill="white"
                                        onClick={() => onScale(scale - 0.5)}
                                    >
                                        <path d="M384 640.5q105 0 180.75-75.75t75.75-180.75-75.75-180.75-180.75-75.75-180.75 75.75-75.75 180.75 75.75 180.75 180.75 75.75zM384 64.5q132 0 225.75 93.75t93.75 225.75-93.75 225.75-225.75 93.75-225.75-93.75-93.75-225.75 93.75-225.75 225.75-93.75zM223.5 352.5h321v63h-321v-63z" />
                                    </svg>
                                    <svg
                                        className="PhotoView-Slider__toolbarIcon"
                                        onClick={() => onRotate(rotate + 90)}
                                        width="44"
                                        height="44"
                                        fill="white"
                                        viewBox="0 0 768 768"
                                    >
                                        <path d="M565.5 202.5l75-75v225h-225l103.5-103.5c-34.5-34.5-82.5-57-135-57-106.5 0-192 85.5-192 192s85.5 192 192 192c84 0 156-52.5 181.5-127.5h66c-28.5 111-127.5 192-247.5 192-141 0-255-115.5-255-256.5s114-256.5 255-256.5c70.5 0 135 28.5 181.5 75z" />
                                    </svg>
                                    {document.fullscreenEnabled && <FullScreenIcon onClick={toggleFullScreen} />}
                                </>
                            );
                        }}>
                        {data.map((item, index) => (

                            <tr key={index}>

                                <td className="text-center py-2 px-4 border-b border-gray-200">
                                    <input
                                        type="checkbox"
                                        checked={selected.includes(item.url)}
                                        onChange={() => toggleOne(item.url)}
                                    />
                                </td>
                                <td onClick={() => handleNameClick(item)} className="text-center py-2 px-4 border-b border-gray-200 text-sm text-gray-700 truncate max-w-48">
                                    {item.url}
                                </td>
                                <td
                                    className="w-20 h-20 sticky left-0 z-10   py-2 px-4 border-b border-gray-500 bg-white text-sm text-gray-700"
                                >

                                    {
                                        isVideo(getImgUrl(item.url)) ? (

                                            <PhotoView key={item.url}
                                                width={elementSize}
                                                height={elementSize}
                                                render={({ scale, attrs }) => {
                                                    const width = attrs.style.width;
                                                    const offset = (width - elementSize) / elementSize;
                                                    const childScale = scale === 1 ? scale + offset : 1 + offset;
                                                    return (
                                                        <div {...attrs} className={`flex-none bg-white ${attrs.className || ''}`}>
                                                            {renderFile(getImgUrl(item.url), index)}
                                                        </div>
                                                    )

                                                }}
                                            >
                                                {renderFile(getImgUrl(item.url), index)}
                                            </PhotoView>
                                        ) : (
                                            <PhotoView key={item.url}
                                                src={getImgUrl(item.url)}
                                            >
                                                {renderFile(getImgUrl(item.url), index)}
                                            </PhotoView>

                                        )
                                    }

                                </td>
                                <td className="text-center py-2 px-4 border-b border-gray-200 text-sm text-gray-700 max-w-48">
                                    {item.time}
                                </td>
                                <td className="text-center py-2 px-4 border-b border-gray-200 text-sm text-gray-700 max-w-48 break-all">
                                    <TooltipItem tooltipsText={item.referer} position="bottom" >{item.referer}</TooltipItem>
                                </td>
                                <td className="text-center py-2 px-4 border-b border-gray-200 text-sm text-gray-700 max-w-48 ">
                                    <TooltipItem tooltipsText={item.ip} position="bottom" >{item.ip}</TooltipItem>
                                </td>
                                <td className="text-center py-2 px-4 border-b border-gray-200 text-sm text-gray-700 max-w-2 ">{item.total}</td>
                                <td className="text-center py-2 px-4 border-b border-gray-200 text-sm text-gray-700 max-w-2 ">{item.rating}</td>
                                <td className="sticky  right-0 z-10 bg-white text-center py-2 px-4 border-b border-gray-200 text-sm text-gray-700">
                                    <div className="flex flex-row justify-center">
                                        <Switcher initialChecked={item.rating} initName={item.url} />
                                        <button
                                            onClick={() => {
                                                handleDelete(item.url)
                                            }}
                                            className="ml-2 px-3 py-1 text-sm font-medium text-white bg-red-600 rounded hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-opacity-50"
                                        >
                                            删除
                                        </button>
                                    </div>
                                </td>
                            </tr>

                        ))}

                    </PhotoProvider>
                </tbody>
            </table>


            {modalData && (
                <div onClick={handleClickOutside} className="fixed z-50 inset-0 overflow-y-auto flex items-center justify-center m-5 ">
                    <div className="fixed inset-0 bg-black opacity-75"></div>
                    <div ref={modalRef} className="bg-white rounded-lg flex-none flex flex-col h-1/2 relative w-9/10 sm:w-9/10 md:w-96 lg:w-120 xl:w-144 2xl:w-160">
                        <button className="absolute top-2 right-2 ring-2 text-red-600 hover:text-red-800" onClick={handleCloseModal}>
                            <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                            </svg>
                        </button>
                        <div className='flex flex-col mt-10 overflow-auto'>
                            {/* 2026-09-19 新增：单图详情（上传时间 / 访问量 / 来源 / IP / 鉴黄 / file_id） */}
                            <div className="mx-2 mb-2 px-3 py-2 bg-slate-50 rounded-lg text-sm text-gray-700 space-y-1">
                                <div><span className="text-gray-500">file_id：</span><span className="break-all">{getLastSegment(modalData.url)}</span></div>
                                <div><span className="text-gray-500">上传时间：</span>{modalData.time || '未知'}</div>
                                <div><span className="text-gray-500">访问量（PV）：</span>{modalData.total == null ? '—' : modalData.total}</div>
                                <div><span className="text-gray-500">来源：</span><span className="break-all">{modalData.referer || '(空)'}</span></div>
                                <div><span className="text-gray-500">上传者 IP：</span>{modalData.ip || '(空)'}</div>
                                <div><span className="text-gray-500">限制访问 / 鉴黄等级：</span>{modalData.rating == null ? '未检测' : modalData.rating}</div>
                                <div>
                                    <a
                                        href={getImgUrl(modalData.url)}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="text-blue-600 underline"
                                    >
                                        在新窗口打开原图
                                    </a>
                                </div>
                            </div>
                            <div className="mx-2 text-xs text-gray-500 mb-1">点下面任意一行即可复制对应格式：</div>
                            {[
                                { text: getImgUrl(modalData.url), onClick: () => handleCopy(getImgUrl(modalData.url)) },
                                { text: `![${modalData.url}](${getImgUrl(modalData.url)})`, onClick: () => handleCopy(`![${modalData.name}](${getImgUrl(modalData.url)})`) },
                                { text: `<a href="${getImgUrl(modalData.url)}" target="_blank"><img src="${getImgUrl(modalData.url)}"></a>`, onClick: () => handleCopy(`<a href="${getImgUrl(modalData.url)}" target="_blank"><img src="${getImgUrl(modalData.url)}"></a>`) },
                                { text: `[img]${getImgUrl(modalData.url)}[/img]`, onClick: () => handleCopy(`[img]${getImgUrl(modalData.url)}[/img]`) },
                            ].map((item, i) => (
                                <input
                                    key={`input-${i}`}
                                    readOnly
                                    value={item.text}
                                    onClick={item.onClick}
                                    className="mx-2 px-3 my-1 py-2 border border-gray-300 rounded-lg bg-white text-sm text-gray-800 focus:outline-none placeholder-gray-400"
                                />


                            ))}
                        </div>

                    </div>
                </div>


            )}

        </div>
    );
}
