/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Link2, Download, Loader2, Play, AlertCircle, Home, Clock, Settings, ChevronRight, Copy, Check, Music } from 'lucide-react';

interface VideoData {
  url: string;
  cover: string;
  desc: string;
  isDemo?: boolean;
}

export default function App() {
  const [inputUrl, setInputUrl] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('shortUrl') || '';
  });
  const [loading, setLoading] = useState(false);
  const [videoData, setVideoData] = useState<VideoData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [history, setHistory] = useState<VideoData[]>([]);

  useEffect(() => {
    const saved = localStorage.getItem('douyin_history');
    if (saved) {
      try {
        setHistory(JSON.parse(saved));
      } catch (e) {
        console.error('Failed to parse history', e);
      }
    }
  }, []);

  const saveToHistory = (data: VideoData) => {
    const newHistory = [data, ...history.filter(h => h.url !== data.url)].slice(0, 20);
    setHistory(newHistory);
    localStorage.setItem('douyin_history', JSON.stringify(newHistory));
  };

  const clearHistory = () => {
    setHistory([]);
    localStorage.removeItem('douyin_history');
  };

  const handleParse = async () => {
    if (!inputUrl.trim()) return;

    setLoading(true);
    setError(null);
    setVideoData(null);

    try {
      const response = await fetch('/api/parse', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ url: inputUrl }),
      });

      const data = await response.json();

      if (data.success) {
        setVideoData(data.data);
        saveToHistory(data.data);
      } else {
        setError(data.error || '解析失败，请检查链接是否正确');
      }
    } catch (err) {
      setError('网络请求失败，请稍后重试');
    } finally {
      setLoading(false);
    }
  };

  const handleDownload = () => {
    if (videoData?.url) {
      const downloadUrl = `/api/proxy?url=${encodeURIComponent(videoData.url)}&download=1`;
      window.location.href = downloadUrl;
    }
  };

  const handlePaste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      setInputUrl(text);
    } catch (err) {
      // Clipboard API might not work in all contexts (e.g. non-secure or iframe without permission)
      console.error('Failed to read clipboard', err);
    }
  };

  return (
    <div className="min-h-screen bg-gray-100 flex justify-center items-start pt-0 md:pt-10 pb-0 md:pb-10 font-sans">
      {/* Mobile Container */}
      <div className="w-full max-w-md h-[100vh] md:h-[850px] bg-slate-50 md:rounded-[3rem] shadow-2xl overflow-hidden relative flex flex-col border-0 md:border-8 border-gray-900/5">

        {/* Status Bar / Header */}
        <div className="h-16 bg-white flex items-center justify-center px-6 border-b border-slate-100 shrink-0 z-10 shadow-sm/50">
          <div className="flex items-center gap-2.5">
            <div className="relative w-9 h-9 bg-[#111] rounded-xl flex items-center justify-center overflow-hidden shadow-md shadow-slate-200">
              <Music className="absolute text-[#24f6f0] translate-x-[2px] translate-y-[2px] opacity-90" size={20} strokeWidth={3} />
              <Music className="absolute text-[#fe2d55] -translate-x-[2px] -translate-y-[2px] opacity-90" size={20} strokeWidth={3} />
              <Music className="relative text-white z-10 mix-blend-normal" size={20} strokeWidth={3} />
            </div>
            <h1 className="font-bold text-slate-900 text-xl tracking-tight flex items-center gap-0.5">
              <span>视</span>
              <span className="text-[#fe2d55]">频</span>
              <span>下</span>
              <span className="text-[#24f6f0]">载</span>
            </h1>
          </div>
        </div>

        {/* Main Content Scroll Area */}
        <div className="flex-1 overflow-y-auto overflow-x-hidden pb-8 scrollbar-hide">

          <div className="p-4 space-y-6">
            {/* Hero Input Card */}
            <div className="bg-white rounded-3xl p-5 shadow-sm border border-slate-100">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 rounded-full bg-indigo-50 flex items-center justify-center text-indigo-600">
                  <Link2 size={20} />
                </div>
                <div>
                  <h2 className="font-bold text-slate-900">视频解析</h2>
                  <p className="text-xs text-slate-500">粘贴链接，一键去除水印</p>
                </div>
              </div>

              <div className="relative mb-4">
                <textarea
                  value={inputUrl}
                  onChange={(e) => setInputUrl(e.target.value)}
                  placeholder="请粘贴抖音分享链接..."
                  className="w-full h-24 bg-slate-50 rounded-xl p-3 text-sm resize-none outline-none focus:ring-2 focus:ring-indigo-500/20 transition-all text-slate-700 placeholder:text-slate-400"
                />
                <button
                  onClick={handlePaste}
                  className="absolute bottom-3 right-3 text-xs bg-white px-2 py-1 rounded-md shadow-sm border border-slate-200 text-indigo-600 font-medium active:scale-95 transition-transform"
                >
                  粘贴
                </button>
              </div>

              <button
                onClick={handleParse}
                disabled={loading || !inputUrl.trim()}
                className="w-full h-12 bg-indigo-600 hover:bg-indigo-700 active:scale-95 text-white rounded-xl font-semibold flex items-center justify-center gap-2 transition-all shadow-lg shadow-indigo-200 disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none"
              >
                {loading ? <Loader2 className="animate-spin" size={20} /> : '立即解析'}
              </button>
            </div>

            {/* Error Message */}
            <AnimatePresence>
              {error && (
                <motion.div
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, height: 0 }}
                  className="bg-red-50 text-red-600 px-4 py-3 rounded-xl flex items-center gap-3 text-sm"
                >
                  <AlertCircle size={16} />
                  {error}
                </motion.div>
              )}
            </AnimatePresence>

            {/* Result Card */}
            <AnimatePresence>
              {videoData && (
                <motion.div
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  className="bg-white rounded-3xl overflow-hidden shadow-sm border border-slate-100"
                >
                  <div className="aspect-video bg-black relative">
                    <video
                      src={`/api/proxy?url=${encodeURIComponent(videoData.url)}`}
                      controls
                      className="w-full h-full object-contain"
                      poster={videoData.cover}
                    />
                  </div>
                  <div className="p-5">
                    <div className="flex items-start justify-between gap-4 mb-4">
                      <h3 className="font-bold text-slate-900 text-sm line-clamp-2 flex-1">
                        {videoData.desc || '抖音视频'}
                      </h3>
                      <span className="shrink-0 px-2 py-1 bg-green-100 text-green-700 text-[10px] font-bold rounded-md">
                        无水印
                      </span>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <button
                        onClick={handleDownload}
                        className="h-10 bg-indigo-600 active:bg-indigo-700 text-white rounded-lg text-sm font-medium flex items-center justify-center gap-2 transition-colors"
                      >
                        <Download size={16} />
                        保存视频
                      </button>
                      <button
                        onClick={() => {
                          navigator.clipboard.writeText(videoData.url);
                          setCopied(true);
                          setTimeout(() => setCopied(false), 2000);
                        }}
                        className="h-10 bg-slate-100 active:bg-slate-200 text-slate-700 rounded-lg text-sm font-medium flex items-center justify-center gap-2 transition-colors"
                      >
                        {copied ? <Check size={16} /> : <Copy size={16} />}
                        {copied ? '已复制' : '复制链接'}
                      </button>
                    </div>
                    {videoData.isDemo && (
                      <p className="mt-3 text-xs text-amber-600 bg-amber-50 p-2 rounded-lg">
                        演示模式：服务器IP受限，仅展示示例视频。
                      </p>
                    )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Guide Section */}
            <div className="bg-white rounded-3xl p-5 shadow-sm border border-slate-100">
              <h3 className="font-bold text-slate-900 mb-4 text-sm">使用教程</h3>
              <div className="space-y-4">
                {[
                  { step: 1, text: '打开抖音，找到视频' },
                  { step: 2, text: '点击分享，复制链接' },
                  { step: 3, text: '返回本应用，粘贴解析' },
                ].map((item) => (
                  <div key={item.step} className="flex items-center gap-3">
                    <div className="w-6 h-6 rounded-full bg-slate-100 text-slate-500 flex items-center justify-center text-xs font-bold shrink-0">
                      {item.step}
                    </div>
                    <span className="text-slate-600 text-sm">{item.text}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Recent History Section */}
            {history.length > 0 && (
              <div className="space-y-3">
                <div className="flex items-center justify-between px-1">
                  <h3 className="font-bold text-slate-900 text-sm">最近记录</h3>
                  <button onClick={clearHistory} className="text-xs text-slate-400 hover:text-slate-600">
                    清除
                  </button>
                </div>
                <div className="space-y-3">
                  {history.map((item, index) => (
                    <div key={index} className="bg-white p-3 rounded-2xl shadow-sm border border-slate-100 flex gap-3">
                      <div className="w-16 h-16 bg-black rounded-lg overflow-hidden shrink-0 relative">
                        <img src={item.cover} alt="cover" className="w-full h-full object-cover" />
                        <div className="absolute inset-0 flex items-center justify-center bg-black/20">
                          <Play size={12} className="text-white fill-white" />
                        </div>
                      </div>
                      <div className="flex-1 flex flex-col justify-between py-1">
                        <h4 className="text-xs font-medium text-slate-900 line-clamp-2 leading-snug">
                          {item.desc || '无标题视频'}
                        </h4>
                        <div className="flex gap-2 mt-1">
                          <a
                            href={`/api/proxy?url=${encodeURIComponent(item.url)}&download=1`}
                            className="text-[10px] bg-indigo-50 text-indigo-600 px-2 py-0.5 rounded-md font-medium flex items-center gap-1"
                          >
                            <Download size={10} /> 下载
                          </a>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

        </div>

      </div>
    </div>
  );
}
