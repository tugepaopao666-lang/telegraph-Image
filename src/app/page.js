"use client";
import { useState, useRef, useCallback } from "react";
import { signOut } from "next-auth/react"
import Image from "next/image";
import { faImages, faTrashAlt, faUpload, faSearchPlus } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { ToastContainer } from "react-toastify";
import { toast } from "react-toastify";
import { useEffect } from 'react';
import Footer from '@/components/Footer'
import Link from "next/link";
import LoadingOverlay from "@/components/LoadingOverlay";

// ============================================================================
// 2026-09-18 本轮修改记录（业主主动要求）
//
// ① 移除页面上那个「上传接口：TG_Channel ▾」下拉框。
//    现在**固定只用 TG_Channel**（= 你自己的 Telegram 频道），
//    不再提供 tg / r2 / 58img 等其它通道，所以页面上没有可选项了。
//      · 删掉 <select> 整块、selectedOption 状态、handleSelectChange 函数；
//      · handleUpload 里的目标地址直接写死 /api/enableauthapi/tgchannel；
//      · 原来「未登录时自动切到 58img」的兜底也一并删除 —— 因为后台已经
//        开了「必须登录才能上传」（ENABLE_AUTH_API = true），未登录本来
//        就传不上去，静默切到一个外部图床反而更让人困惑。
//
// ② 401 的提示改成人话：原来是「无权限访问资源: ...」，现在是「请先登录后再上传」。
//
// ③ 修掉压缩阈值那行过期注释（它写着「压到 1.2MB 以内」，实际阈值是 8MB）。
//
// ④ 下面的压缩函数本身**保持不变**（它本来就在这个文件里，不必再单独粘一遍）。
// ============================================================================
// 2026-09-19 本轮：首页体验 6 项
//   ① 上传进度条（N/M + 百分比）
//   ② 整页拖拽：拖到页面任何地方都能收，并有一层提示遮罩
//   ③ 一键复制全部直链（每行一条）
//   ④ 记住上次看的那一页（Preview / HTML / Markdown / BBCode / Links）
//   ⑤ 手机上更紧凑（缩略图变小、链接区竖排）
//   ⑥ 文案核对：把上传上限那句改成真实的两种上限（图片 10MB / 其它文件 50MB）
// ============================================================================

const LoginButton = ({ onClick, href, children }) => (
  <button
    onClick={onClick}
    className="px-4 py-2 mx-2 w-28 sm:w-28 md:w-20 lg:w-16 xl:w-16 2xl:w-20 bg-blue-500 text-white rounded"
  >
    {children}
  </button>
);

// ===== 上传前在浏览器里先压一遍图片 =====

// 为什么放在前端压：Cloudflare 的 Edge 运行时没有图像处理库，服务端压不了；
// 而"传不上去"最常见的原因，就是手机随手拍的照片超过了 Telegram 的 10MB 上限。
// 在浏览器里先压一遍，既省上传流量，也让大图能顺利传上去。
//
// 设计原则（很重要）：**只在明显超大时才动手，任何一步出错都原样退回原图**。
// 所以它不可能把一张原本能传的图弄成传不了。

const COMPRESS_TRIGGER_BYTES = 10 * 1024 * 1024;  // 超过 10MB 才考虑压
// 目标大小：压到 8MB 以内。
// ⚠️ 别把这个值改小去"多压一点" —— Telegram sendPhoto 的上限就是 10MB，
//    只有超标才需要压；压过头只会白白掉画质。
const COMPRESS_TARGET_BYTES = 8 * 1024 * 1024;
const COMPRESS_MAX_EDGE = 2560;                  // 最长边不超过 2560 像素

async function compressImageIfNeeded(file) {
  try {
    if (!file || typeof file !== 'object') return file;

    const type = file.type || '';
    // 只处理位图。GIF 一动就掉帧，SVG 是矢量的、转了反而变糊 —— 都不碰。
    if (!type.startsWith('image/')) return file;
    if (type === 'image/gif' || type === 'image/svg+xml') return file;
    if (file.size <= COMPRESS_TRIGGER_BYTES) return file;
    if (typeof createImageBitmap !== 'function') return file;

    const bitmap = await createImageBitmap(file);
    const w0 = bitmap.width;
    const h0 = bitmap.height;
    if (!w0 || !h0) return file;

    const scale = Math.min(1, COMPRESS_MAX_EDGE / Math.max(w0, h0));
    const w = Math.max(1, Math.round(w0 * scale));
    const h = Math.max(1, Math.round(h0 * scale));

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;

    // 先铺白底：PNG 的透明区域转成 JPEG 后默认会变黑，铺白更符合直觉
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bitmap, 0, 0, w, h);
    if (typeof bitmap.close === 'function') {
      try { bitmap.close(); } catch (e) { /* 忽略 */ }
    }

    const toBlob = (quality) => new Promise((resolve) => {
      try {
        canvas.toBlob((b) => resolve(b), 'image/jpeg', quality);
      } catch (e) {
        resolve(null);
      }
    });

    let quality = 0.82;
    let blob = await toBlob(quality);
    // 逐步降质量，直到进入目标大小（最多降 4 档，避免压得太糊）
    let guard = 0;
    while (blob && blob.size > COMPRESS_TARGET_BYTES && quality > 0.5 && guard < 4) {
      quality -= 0.1;
      guard++;
      blob = await toBlob(quality);
    }

    // 压完反而更大（小图、纯色图很常见）→ 老实退回原图
    if (!blob || blob.size >= file.size) return file;

    const newName = (file.name || 'image').replace(/\.[^.]+$/, '') + '.jpg';
    return new File([blob], newName, { type: 'image/jpeg', lastModified: Date.now() });
  } catch (e) {
    // 任何意外都退回原图 —— 压缩只是加分项，不该成为上传失败的原因
    return file;
  }
}
export default function Home() {
  const [selectedFiles, setSelectedFiles] = useState([]);
  const [uploadedImages, setUploadedImages] = useState([]);
  const [uploadedFilesNum, setUploadedFilesNum] = useState(0);
  const [selectedImage, setSelectedImage] = useState(null); // 添加状态用于跟踪选中的放大图片
  const [activeTab, setActiveTab] = useState('preview');
  const [uploading, setUploading] = useState(false);
  const [IP, setIP] = useState('');
  const [Total, setTotal] = useState('?');
  const [isAuthapi, setisAuthapi] = useState(false); // 初始选择第一个选项
  const [Loginuser, setLoginuser] = useState(''); // 初始选择第一个选项
  const [boxType, setBoxtype] = useState("img");

  // ---- 2026-09-19 新增：进度 / 拖拽 ----
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [dragActive, setDragActive] = useState(false);

  const origin = typeof window !== 'undefined' ? window.location.origin : '';


  const parentRef = useRef(null);






  let headers = {

    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36",

  }
  useEffect(() => {
    ip();
    getTotal();
    isAuth();

    // 记住上次看的那一页（2026-09-19 新增）。localStorage 在无痕/隐私模式下可能不可用，
    // 所以整段包在 try 里 —— 存不了就不存，绝不能让页面因此出错。
    try {
      const savedTab = window.localStorage.getItem('tbc_active_tab');
      if (savedTab) setActiveTab(savedTab);
    } catch (e) { /* 忽略 */ }
  }, []);
  const ip = async () => {
    try {

      const res = await fetch(`/api/ip`, {
        method: "GET",
        headers: {
          'Content-Type': 'application/json'
        }

      });
      const data = await res.json();
      setIP(data.ip);



    } catch (error) {
      console.error('请求出错:', error);
    }
  };
  const isAuth = async () => {
    try {

      const res = await fetch(`/api/enableauthapi/isauth`, {
        method: "GET",
        headers: {
          'Content-Type': 'application/json'
        }

      });

      if (res.ok) {
        const data = await res.json();
        setisAuthapi(true)
        setLoginuser(data.role)

      } else {
        setisAuthapi(false)
      }



    } catch (error) {
      console.error('请求出错:', error);
    }
  };

  const getTotal = async () => {
    try {

      const res = await fetch(`/api/total`, {
        method: "GET",
        headers: {
          'Content-Type': 'application/json'
        }

      });
      const data = await res.json();
      setTotal(data.total);



    } catch (error) {
      console.error('请求出错:', error);
    }
  }

  const handleFileChange = (event) => {
    const newFiles = event.target.files;
    const filteredFiles = Array.from(newFiles).filter(file =>
      !selectedFiles.find(selFile => selFile.name === file.name));
    // 过滤掉已经在 uploadedImages 数组中存在的文件
    const uniqueFiles = filteredFiles.filter(file =>
      !uploadedImages.find(upImg => upImg.name === file.name)
    );

    setSelectedFiles([...selectedFiles, ...uniqueFiles]);
  };

  const handleClear = () => {
    setSelectedFiles([]);
    setUploadStatus('');
    // setUploadedImages([]);
  };

  const getTotalSizeInMB = (files) => {
    const totalSizeInBytes = Array.from(files).reduce((acc, file) => acc + file.size, 0);
    return (totalSizeInBytes / (1024 * 1024)).toFixed(2); // 转换为MB并保留两位小数
  };



  const handleUpload = async (file = null) => {
    setUploading(true);

    const filesToUpload = file ? [file] : selectedFiles;

    if (filesToUpload.length === 0) {
      toast.error('请选择要上传的文件');
      setUploading(false);
      return;
    }

    setProgress({ done: 0, total: filesToUpload.length });
    // 固定只走 TG_Channel（上传到自己的 Telegram 频道）—— 页面已无其它通道可选
    const formFieldName = "file";
    const targetUrl = "/api/enableauthapi/tgchannel";
    let successCount = 0;

    try {
      for (const file of filesToUpload) {
        const formData = new FormData();

        formData.append(formFieldName, await compressImageIfNeeded(file));

        try {
          // const response = await fetch("https://img.131213.xyz/api/tencent", {
          const response = await fetch(targetUrl, {
            method: 'POST',
            body: formData,
            headers: headers
          });

          if (response.ok) {
            const result = await response.json();
            // console.log(result);

            file.url = result.url;

            // 更新 uploadedImages 和 selectedFiles
            setUploadedImages((prevImages) => [...prevImages, file]);
            setSelectedFiles((prevFiles) => prevFiles.filter(f => f !== file));
            successCount++;
          } else {
            // 尝试从响应中提取错误信息
            let errorMsg;
            try {
              const errorData = await response.json();
              errorMsg = errorData.message || `上传 ${file.name} 图片时出错`;
            } catch (jsonError) {
              // 如果解析 JSON 失败，使用默认错误信息
              errorMsg = `上传 ${file.name} 图片时发生未知错误`;
            }

            // 细化状态码处理
            switch (response.status) {
              case 400:
                toast.error(`请求无效: ${errorMsg}`);
                break;
              case 403:
                toast.error(`无权限访问资源: ${errorMsg}`);
                break;
              case 404:
                toast.error(`资源未找到: ${errorMsg}`);
                break;
              case 500:
                toast.error(`服务器错误: ${errorMsg}`);
                break;
              case 401:
                // 后台开着「必须登录才能上传」（ENABLE_AUTH_API = true），
                // 未登录时走这里。给一句人话，不要让人对着 "未授权" 发呆。
                toast.error('请先登录后再上传');
                break;
              default:
                toast.error(`上传 ${file.name} 图片时出错: ${errorMsg}`);
            }
          }
        } catch (error) {
          toast.error(`上传 ${file.name} 图片时出错`);
        }

        // 每处理完一个就推进一格（不区分成功失败 —— 进度条表达的是"处理到哪了"）
        setProgress((p) => ({ done: p.done + 1, total: p.total || filesToUpload.length }));
      }

      setUploadedFilesNum(uploadedFilesNum + successCount);
      toast.success(`已成功上传 ${successCount} 张图片`);

    } catch (error) {
      console.error('上传过程中出现错误:', error);
      toast.error('上传错误');
    } finally {
      setUploading(false);
      setProgress({ done: 0, total: 0 });
    }
  };





  const handlePaste = (event) => {
    const clipboardItems = event.clipboardData.items;

    for (let i = 0; i < clipboardItems.length; i++) {
      const item = clipboardItems[i];
      if (item.kind === 'file' && item.type.includes('image')) {
        const file = item.getAsFile();
        setSelectedFiles([...selectedFiles, file]);
        break; // 只处理第一个文件
      }
    }
  };

  const handleDrop = (event) => {
    event.preventDefault();
    const files = event.dataTransfer.files;

    if (files.length > 0) {
      const filteredFiles = Array.from(files).filter(file => !selectedFiles.find(selFile => selFile.name === file.name));
      setSelectedFiles([...selectedFiles, ...filteredFiles]);
    }
  };

  const handleDragOver = (event) => {
    event.preventDefault();
  };

  // 根据图片数量动态计算容器高度
  const calculateMinHeight = () => {
    const rows = Math.ceil(selectedFiles.length / 4);
    return `${rows * 100}px`;
  };

  // 处理点击图片放大
  const handleImageClick = (index) => {

    if (selectedFiles[index].type.startsWith('image/')) {
      setBoxtype("img");
    } else if (selectedFiles[index].type.startsWith('video/')) {
      setBoxtype("video");
    } else {
      setBoxtype("other");
    }

    setSelectedImage(URL.createObjectURL(selectedFiles[index]));
  };

  const handleCloseImage = () => {
    setSelectedImage(null);
  };

  const handleRemoveImage = (index) => {
    const updatedFiles = selectedFiles.filter((_, idx) => idx !== index);
    setSelectedFiles(updatedFiles);
  };

  const handleCopy = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      // alert('已成功复制到剪贴板');
      toast.success(`链接复制成功`);
    } catch (err) {
      toast.error("链接复制失败")
    }
  };

  const handleCopyCode = async () => {
    const codeElements = parentRef.current.querySelectorAll('code');
    const values = Array.from(codeElements).map(code => code.textContent);
    try {
      await navigator.clipboard.writeText(values.join("\n"));
      toast.success(`链接复制成功`);

    } catch (error) {
      toast.error(`链接复制失败\n${error}`)
    }
  }

  /** 一键复制全部直链（每行一条）—— 2026-09-19 新增 */
  const handleCopyAll = async () => {
    const urls = uploadedImages.map((d) => d.url).filter(Boolean);
    if (!urls.length) {
      toast.error('还没有上传成功的图片');
      return;
    }
    try {
      await navigator.clipboard.writeText(urls.join('\n'));
      toast.success(`已复制 ${urls.length} 条直链`);
    } catch (err) {
      toast.error('复制失败，请手动选中复制');
    }
  };

  /** 切标签页并记住它 —— 2026-09-19 新增 */
  const switchTab = (t) => {
    setActiveTab(t);
    try { window.localStorage.setItem('tbc_active_tab', t); } catch (e) { /* 忽略 */ }
  };

  /** 整页拖拽的三个处理函数 —— 2026-09-19 新增 */
  const handleDragOverAll = (event) => {
    event.preventDefault();
    if (!dragActive) setDragActive(true);
  };
  const handleDragLeaveAll = (event) => {
    // 拖到子元素上也会触发 leave，所以只在"真正离开 main"时才取消
    if (event.currentTarget === event.target) setDragActive(false);
  };
  const handleDropAll = (event) => {
    event.preventDefault();
    setDragActive(false);
    handleDrop(event);
  };

  const handlerenderImageClick = (imageUrl, type) => {
    setBoxtype(type);
    setSelectedImage(imageUrl);
  };


  const renderFile = (data, index) => {
    const fileUrl = data.url;
    if (data.type.startsWith('image/')) {
      return (
        <img
          key={`image-${index}`}
          src={data.url}
          alt={`Uploaded ${index}`}
          className="object-cover w-36 h-40 m-2"
          onClick={() => handlerenderImageClick(fileUrl, "img")}
        />
      );

    } else if (data.type.startsWith('video/')) {
      return (
        <video
          key={`video-${index}`}
          src={data.url}
          className="object-cover w-36 h-40 m-2"
          controls
          onClick={() => handlerenderImageClick(fileUrl, "video")}
        >
          Your browser does not support the video tag.
        </video>
      );

    } else {
      // 其他文件类型
      return (
        <img
          key={`image-${index}`}
          src={data.url}
          alt={`Uploaded ${index}`}
          className="object-cover w-36 h-40 m-2"
          onClick={() => handlerenderImageClick(fileUrl, "other")}
        />
      );
    }



  };


  const renderTabContent = () => {
    switch (activeTab) {
      case 'preview':
        return (
          <div className=" flex flex-col ">
            {uploadedImages.map((data, index) => (
              <div key={index} className="m-2 rounded-2xl ring-offset-2 ring-2 ring-slate-100 flex flex-col sm:flex-row ">
                {renderFile(data, index)}
                <div className="flex flex-col justify-center w-full sm:w-4/5">
                  {[
                    { text: data.url, onClick: () => handleCopy(data.url) },
                    { text: `![${data.name}](${data.url})`, onClick: () => handleCopy(`![${data.name}](${data.url})`) },
                    { text: `<a href="${data.url}" target="_blank"><img src="${data.url}"></a>`, onClick: () => handleCopy(`<a href="${data.url}" target="_blank"><img src="${data.url}"></a>`) },
                    { text: `[img]${data.url}[/img]`, onClick: () => handleCopy(`[img]${data.url}[/img]`) },
                  ].map((item, i) => (
                    <input
                      key={`input-${i}`}
                      readOnly
                      value={item.text}
                      onClick={item.onClick}
                      className="px-3 my-1 py-2 border border-gray-300 rounded-lg bg-white text-sm text-gray-800 focus:outline-none placeholder-gray-400"
                    />
                  ))}
                </div>
              </div>

            ))}
          </div>
        );
      case 'htmlLinks':
        return (
          <div ref={parentRef} className=" p-4 bg-slate-100  " onClick={handleCopyCode}>
            {uploadedImages.map((data, index) => (
              <div key={index} className="mb-2 ">
                <code className=" w-2 break-all">{`<img src="${data.url}" alt="${data.name}" />`}</code>
              </div>
            ))}
          </div >
        );
      case 'markdownLinks':
        return (
          <div ref={parentRef} className=" p-4 bg-slate-100  " onClick={handleCopyCode}>
            {uploadedImages.map((data, index) => (
              <div key={index} className="mb-2">
                <code className=" w-2 break-all">{`![${data.name}](${data.url})`}</code>
              </div>
            ))}
          </div>
        );
      case 'bbcodeLinks':
        return (
          <div ref={parentRef} className=" p-4 bg-slate-100  " onClick={handleCopyCode}>
            {uploadedImages.map((data, index) => (
              <div key={index} className="mb-2">
                <code className=" w-2 break-all">{`[img]${data.url}[/img]`}</code>
              </div>
            ))}
          </div>
        );
      case 'viewLinks':
        return (
          <div ref={parentRef} className=" p-4 bg-slate-100  " onClick={handleCopyCode}>
            {uploadedImages.map((data, index) => (
              <div key={index} className="mb-2">
                <code className=" w-2 break-all">{`${data.url}`}</code>
              </div>
            ))}
          </div>
        );
      default:
        return null;
    }
  };


  const handleSignOut = () => {
    signOut({ callbackUrl: '/' });
  };

  const renderButton = () => {
    if (!isAuthapi) {
      return (
        <Link href="/login">
          <LoginButton>登录</LoginButton>
        </Link>
      );
    }
    switch (Loginuser) {
      case 'user':
        return <LoginButton onClick={handleSignOut}>登出</LoginButton>;
      case 'admin':
        return (
          <Link href="/admin">
            <LoginButton>管理</LoginButton>
          </Link>
        );
      default:
        return (
          <Link href="/login">
            <LoginButton>登录</LoginButton>
          </Link>
        );
    }
  };


  return (
    <main
      className=" overflow-auto h-full flex w-full min-h-screen flex-col items-center justify-between"
      onDragOver={handleDragOverAll}
      onDragLeave={handleDragLeaveAll}
      onDrop={handleDropAll}
    >
      {dragActive && (
        <div className="fixed inset-0 z-[60] bg-blue-500 bg-opacity-20 border-4 border-dashed border-blue-500 flex items-center justify-center pointer-events-none">
          <div className="bg-white rounded-lg px-6 py-4 text-blue-600 text-lg shadow">
            松手就上传
          </div>
        </div>
      )}
      <header className="fixed top-0 h-[50px] left-0 w-full border-b bg-white flex z-50 justify-center items-center">
        <nav className="flex justify-between items-center w-full max-w-4xl px-4">图床</nav>
        {renderButton()}
      </header>
      <div className="mt-[60px] w-9/10 sm:w-9/10 md:w-9/10 lg:w-9/10 xl:w-3/5 2xl:w-2/3">

        <div className="flex flex-row">
          <div className="flex flex-col">
            <div className="text-gray-800 text-lg">图片或视频上传
            </div>
            <div className="mb-4 text-sm text-gray-500">
              图片 ≤10MB（超出会自动压缩）、其它文件 ≤50MB · 本站已托管 <span className="text-cyan-600">{Total}</span> 张图片 · 你访问本站的IP是：<span className="text-cyan-600">{IP}</span>
            </div>
          </div>
          {/* 原来这里有一个「上传接口：TG_Channel ▾」下拉框。
              2026-09-18 已整块移除 —— 现在固定只上传到 TG_Channel，
              没有可选项，所以不需要这个选择器。 */}
        </div>
        <div
          className="border-2 border-dashed border-slate-400 rounded-md relative"
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onPaste={handlePaste}
          style={{ minHeight: calculateMinHeight() }} // 动态设置最小高度
        >
          <div className="flex flex-wrap gap-3 min-h-[240px]">
            <LoadingOverlay loading={uploading} />
            {selectedFiles.map((file, index) => (
              <div key={index} className="relative rounded-2xl w-32 h-40 sm:w-44 sm:h-48 ring-offset-2 ring-2 mx-2 sm:mx-3 my-3 flex flex-col items-center">
                <div className="relative w-24 h-24 sm:w-36 sm:h-36" onClick={() => handleImageClick(index)}>
                  {file.type.startsWith('image/') && (
                    <Image
                      src={URL.createObjectURL(file)}
                      alt={`Preview ${file.name}`}
                      fill={true}
                    />
                  )}
                  {file.type.startsWith('video/') && (
                    <video
                      src={URL.createObjectURL(file)}
                      controls
                      className="w-full h-full"
                    />
                  )}
                  {!file.type.startsWith('image/') && !file.type.startsWith('video/') && (
                    <div className="flex items-center justify-center w-full h-full bg-gray-200 text-gray-700">
                      <p>{file.name}</p>
                    </div>
                  )}
                </div>
                <div className="flex flex-row items-center  justify-center w-full mt-3">
                  <button
                    className="bg-blue-500 text-white rounded-full w-6 h-6 flex items-center justify-center cursor-pointer mx-2"
                    onClick={() => handleImageClick(index)}
                  >
                    <FontAwesomeIcon icon={faSearchPlus} />
                  </button>
                  <button
                    className="bg-red-500 text-white rounded-full w-6 h-6 flex items-center justify-center cursor-pointer mx-2"
                    onClick={() => handleRemoveImage(index)}
                  >
                    <FontAwesomeIcon icon={faTrashAlt} />
                  </button>
                  <button
                    className="bg-green-500 text-white rounded-full w-6 h-6 flex items-center justify-center cursor-pointer mx-2"

                    onClick={() => handleUpload(file)}
                  >
                    <FontAwesomeIcon icon={faUpload} />
                  </button>
                </div>
              </div>
            ))}


            {selectedFiles.length === 0 && (
              <div className="absolute -z-10 left-0 top-0 w-full h-full flex items-center justify-center">

                <div className="text-gray-500">

                  拖拽文件到这里或将屏幕截图复制并粘贴到此处上传
                </div>
              </div>
            )}

          </div>
        </div>
        {uploading && progress.total > 0 && (
          <div className="w-full mt-3">
            <div className="flex justify-between text-xs text-gray-500 mb-1">
              <span>正在上传…</span>
              <span>{progress.done} / {progress.total}</span>
            </div>
            <div className="w-full h-2 bg-slate-200 rounded-full overflow-hidden">
              <div
                className="h-full bg-blue-500 transition-all"
                style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }}
              />
            </div>
          </div>
        )}
        <div className="w-full rounded-md shadow-sm overflow-hidden mt-4 grid grid-cols-8">
          <div className="md:col-span-1 col-span-8">
            <label
              htmlFor="file-upload"
              className="w-full h-10 bg-blue-500 cursor-pointer flex items-center justify-center text-white"
            >
              <FontAwesomeIcon icon={faImages} style={{ width: '20px', height: '20px' }} className="mr-2" />
              选择图片
            </label>
            <input
              id="file-upload"
              type="file"
              className="hidden"
              onChange={handleFileChange}
              multiple
            />
          </div>
          <div className="md:col-span-5 col-span-8">
            <div className="w-full h-10 bg-slate-200 leading-10 px-4 text-center md:text-left">
              已选择 {selectedFiles.length} 张，共 {getTotalSizeInMB(selectedFiles)} M
            </div>
          </div>
          <div className="md:col-span-1 col-span-3">
            <div
              className="w-full bg-red-500 cursor-pointer h-10 flex items-center justify-center text-white"
              onClick={handleClear}
            >
              <FontAwesomeIcon icon={faTrashAlt} style={{ width: '20px', height: '20px' }} className="mr-2" />
              清除
            </div>
          </div>
          <div className="md:col-span-1 col-span-5">
            <div
              className={`w-full bg-green-500 cursor-pointer h-10 flex items-center justify-center text-white ${uploading ? 'pointer-events-none opacity-50' : ''}`}
              // className={`bg-green-500 text-white rounded-full w-6 h-6 flex items-center justify-center cursor-pointer mx-2 ${uploading ? 'pointer-events-none opacity-50' : ''}`}

              onClick={() => handleUpload()}
            >
              <FontAwesomeIcon icon={faUpload} style={{ width: '20px', height: '20px' }} className="mr-2" />
              上传
            </div>
          </div>
        </div>


        <ToastContainer />
        <div className="w-full mt-4 min-h-[200px] mb-[60px] ">

          {
            uploadedImages.length > 0 && (<>
              <div className="flex flex-wrap gap-3 mb-4 border-b border-gray-300 ">
                <button
                  onClick={() => switchTab('preview')}
                  className={`px-4 py-2 ${activeTab === 'preview' ? 'bg-blue-500 text-white' : 'bg-gray-200 text-gray-800'}`}>
                  Preview
                </button>
                <button
                  onClick={() => switchTab('htmlLinks')}
                  className={`px-4 py-2 ${activeTab === 'htmlLinks' ? 'bg-blue-500 text-white' : 'bg-gray-200 text-gray-800'}`}>
                  HTML
                </button>
                <button
                  onClick={() => switchTab('markdownLinks')}
                  className={`px-4 py-2 ${activeTab === 'markdownLinks' ? 'bg-blue-500 text-white' : 'bg-gray-200 text-gray-800'}`}>
                  Markdown
                </button>
                <button
                  onClick={() => switchTab('bbcodeLinks')}
                  className={`px-4 py-2 ${activeTab === 'bbcodeLinks' ? 'bg-blue-500 text-white' : 'bg-gray-200 text-gray-800'}`}>
                  BBCode
                </button>
                <button
                  onClick={() => switchTab('viewLinks')}
                  className={`px-4 py-2 ${activeTab === 'viewLinks' ? 'bg-blue-500 text-white' : 'bg-gray-200 text-gray-800'}`}>
                  Links
                </button>
                <button
                  onClick={handleCopyAll}
                  className="px-4 py-2 bg-emerald-500 text-white rounded sm:ml-auto">
                  一键复制全部直链
                </button>
              </div>
              {renderTabContent()}
            </>
            )
          }
        </div>

      </div>
      {selectedImage && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50" onClick={handleCloseImage}>
          <div className="relative flex flex-col items-center justify-between">
            <button
              className="absolute top-2 right-2 bg-red-500 text-white rounded-full w-8 h-8 flex items-center justify-center"
              onClick={handleCloseImage}
            >
              &times;
            </button>

            {boxType === "img" ? (
              <img
                src={selectedImage}
                alt="Selected"
                width={500}
                height={500}
                className="object-cover w-9/10  h-auto rounded-lg"
              />
            ) : boxType === "video" ? (
              <video
                src={selectedImage}
                width={500}
                height={500}
                className="object-cover w-9/10  h-auto rounded-lg"
                controls
              />
            ) : boxType === "other" ? (
              // 这里可以渲染你想要的其他内容或组件
              <div className="p-4 bg-white text-black rounded">
                <p>Unsupported file type</p>
              </div>
            ) : (
              // 你可以选择一个默认的内容或者返回 null
              <div>未知类型</div>
            )}
          </div>

        </div>

      )}

      <div className="fixed inset-x-0 bottom-0 h-[50px] bg-slate-200  w-full  flex  z-50 justify-center items-center ">
        <Footer />
      </div>
    </main>
  );
}
