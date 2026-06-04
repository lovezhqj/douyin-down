import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
    LayoutDashboard, Settings, LogOut, Shield, Menu, X,
    TrendingUp, Calendar, Image, Mic, Video, Type, Wand2, Eraser, FileText
} from 'lucide-react';

// ============================================================
// Types
// ============================================================
interface DashboardStats {
    totalCount: number;
    todayCount: number;
    items: Array<{
        biz_code: string;
        biz_name: string;
        total_count: number;
        today_count: number;
    }>;
}

interface QuotaConfig {
    id: number;
    biz_code: string;
    biz_name: string;
    daily_free_limit: number;
    daily_max_limit: number;
}

// ============================================================
// Icons mapping for business functions
// ============================================================
const BIZ_ICONS: Record<string, React.ReactNode> = {
    photo_restore: <Image size={20} />,
    anime_convert: <Wand2 size={20} />,
    voice_clone: <Mic size={20} />,
    text_to_image: <Type size={20} />,
    text_to_speech: <Mic size={20} />,
    remove_watermark: <Eraser size={20} />,
    image_to_video: <Video size={20} />,
    video_transcript: <FileText size={20} />,
};

const BIZ_GRADIENTS: Record<string, string> = {
    photo_restore: 'from-blue-500 to-cyan-400',
    anime_convert: 'from-purple-500 to-pink-400',
    voice_clone: 'from-emerald-500 to-teal-400',
    text_to_image: 'from-orange-500 to-amber-400',
    text_to_speech: 'from-rose-500 to-pink-400',
    remove_watermark: 'from-indigo-500 to-violet-400',
    image_to_video: 'from-fuchsia-500 to-purple-400',
    video_transcript: 'from-sky-500 to-blue-400',
};

// ============================================================
// API Helper
// ============================================================
function getToken(): string | null {
    return sessionStorage.getItem('admin_token');
}

async function adminFetch(url: string, options: RequestInit = {}): Promise<any> {
    const token = getToken();
    const res = await fetch(url, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(options.headers || {}),
        },
    });
    const data = await res.json();
    if (res.status === 401) {
        sessionStorage.removeItem('admin_token');
        window.location.hash = '#/admin/login';
        throw new Error('登录已过期');
    }
    return data;
}

// ============================================================
// Login Page
// ============================================================
function LoginPage({ onLogin }: { onLogin: (token: string) => void }) {
    const [token, setToken] = useState('');
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!token.trim()) return;
        setLoading(true);
        setError('');
        try {
            const data = await fetch('/api/admin/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token: token.trim() }),
            }).then(r => r.json());

            if (data.success) {
                sessionStorage.setItem('admin_token', token.trim());
                onLogin(token.trim());
            } else {
                setError(data.error || '登录失败');
            }
        } catch {
            setError('网络请求失败');
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 flex items-center justify-center p-4">
            {/* Background decoration */}
            <div className="absolute inset-0 overflow-hidden pointer-events-none">
                <div className="absolute top-1/4 -left-20 w-96 h-96 bg-indigo-600/10 rounded-full blur-3xl" />
                <div className="absolute bottom-1/4 -right-20 w-96 h-96 bg-purple-600/10 rounded-full blur-3xl" />
            </div>

            <motion.div
                initial={{ opacity: 0, y: 30 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.6, ease: 'easeOut' }}
                className="relative w-full max-w-md"
            >
                {/* Glass card */}
                <div className="bg-white/[0.06] backdrop-blur-2xl rounded-3xl border border-white/10 shadow-2xl shadow-black/20 p-8">
                    {/* Logo */}
                    <div className="flex flex-col items-center mb-8">
                        <div className="w-16 h-16 bg-gradient-to-br from-indigo-500 to-purple-600 rounded-2xl flex items-center justify-center shadow-lg shadow-indigo-500/30 mb-4">
                            <Shield className="text-white" size={28} />
                        </div>
                        <h1 className="text-2xl font-bold text-white tracking-tight">管理中心</h1>
                        <p className="text-slate-400 text-sm mt-1">请输入管理员 Token 登录</p>
                    </div>

                    {/* Form */}
                    <form onSubmit={handleSubmit} className="space-y-5">
                        <div>
                            <label className="block text-sm font-medium text-slate-300 mb-2">
                                Token 密钥
                            </label>
                            <input
                                type="password"
                                value={token}
                                onChange={(e) => setToken(e.target.value)}
                                placeholder="请输入管理员 Token..."
                                className="w-full h-12 bg-white/[0.06] border border-white/10 rounded-xl px-4 text-white placeholder:text-slate-500 outline-none focus:border-indigo-500/50 focus:ring-2 focus:ring-indigo-500/20 transition-all text-sm"
                                autoFocus
                            />
                        </div>

                        <AnimatePresence>
                            {error && (
                                <motion.div
                                    initial={{ opacity: 0, y: -8 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    exit={{ opacity: 0, height: 0 }}
                                    className="bg-red-500/10 border border-red-500/20 text-red-400 text-sm rounded-lg px-4 py-2.5"
                                >
                                    {error}
                                </motion.div>
                            )}
                        </AnimatePresence>

                        <button
                            type="submit"
                            disabled={loading || !token.trim()}
                            className="w-full h-12 bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700 text-white rounded-xl font-semibold text-sm flex items-center justify-center gap-2 transition-all shadow-lg shadow-indigo-500/25 disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.98]"
                        >
                            {loading ? (
                                <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24" fill="none">
                                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                                </svg>
                            ) : '登 录'}
                        </button>
                    </form>
                </div>
            </motion.div>
        </div>
    );
}

// ============================================================
// Dashboard Page
// ============================================================
function DashboardPage() {
    const [stats, setStats] = useState<DashboardStats | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        loadStats();
    }, []);

    const loadStats = async () => {
        setLoading(true);
        try {
            const data = await adminFetch('/api/admin/dashboard');
            if (data.success) {
                setStats(data.data);
            }
        } catch (e) {
            console.error('Failed to load stats', e);
        } finally {
            setLoading(false);
        }
    };

    if (loading) {
        return (
            <div className="flex items-center justify-center h-64">
                <svg className="animate-spin h-8 w-8 text-indigo-500" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
            </div>
        );
    }

    if (!stats) return null;

    return (
        <div className="space-y-8">
            {/* Page title */}
            <div>
                <h2 className="text-2xl font-bold text-slate-900">仪表盘</h2>
                <p className="text-slate-500 text-sm mt-1">业务功能使用数据概览</p>
            </div>

            {/* Summary Cards */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.1 }}
                    className="bg-gradient-to-br from-indigo-500 to-purple-600 rounded-2xl p-6 text-white shadow-lg shadow-indigo-500/20"
                >
                    <div className="flex items-center gap-3 mb-3">
                        <div className="w-10 h-10 bg-white/20 rounded-xl flex items-center justify-center backdrop-blur-sm">
                            <TrendingUp size={20} />
                        </div>
                        <span className="text-white/80 text-sm font-medium">总调用次数</span>
                    </div>
                    <p className="text-4xl font-bold tracking-tight">{stats.totalCount.toLocaleString()}</p>
                </motion.div>

                <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.2 }}
                    className="bg-gradient-to-br from-emerald-500 to-teal-500 rounded-2xl p-6 text-white shadow-lg shadow-emerald-500/20"
                >
                    <div className="flex items-center gap-3 mb-3">
                        <div className="w-10 h-10 bg-white/20 rounded-xl flex items-center justify-center backdrop-blur-sm">
                            <Calendar size={20} />
                        </div>
                        <span className="text-white/80 text-sm font-medium">今日调用次数</span>
                    </div>
                    <p className="text-4xl font-bold tracking-tight">{stats.todayCount.toLocaleString()}</p>
                </motion.div>
            </div>

            {/* Business Function Cards */}
            <div>
                <h3 className="text-lg font-semibold text-slate-800 mb-4">业务功能明细</h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                    {stats.items.map((item, index) => (
                        <motion.div
                            key={item.biz_code}
                            initial={{ opacity: 0, y: 20 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: 0.1 + index * 0.05 }}
                            className="bg-white rounded-2xl border border-slate-100 p-5 shadow-sm hover:shadow-md transition-shadow"
                        >
                            <div className="flex items-center gap-3 mb-4">
                                <div className={`w-10 h-10 rounded-xl bg-gradient-to-br ${BIZ_GRADIENTS[item.biz_code] || 'from-slate-500 to-slate-400'} flex items-center justify-center text-white shadow-sm`}>
                                    {BIZ_ICONS[item.biz_code] || <Settings size={20} />}
                                </div>
                                <h4 className="font-semibold text-slate-800 text-sm">{item.biz_name}</h4>
                            </div>
                            <div className="grid grid-cols-2 gap-3">
                                <div className="bg-slate-50 rounded-xl p-3">
                                    <p className="text-[11px] text-slate-400 font-medium mb-1">总使用次数</p>
                                    <p className="text-xl font-bold text-slate-900">{item.total_count.toLocaleString()}</p>
                                </div>
                                <div className="bg-indigo-50 rounded-xl p-3">
                                    <p className="text-[11px] text-indigo-400 font-medium mb-1">今日使用</p>
                                    <p className="text-xl font-bold text-indigo-600">{item.today_count.toLocaleString()}</p>
                                </div>
                            </div>
                        </motion.div>
                    ))}
                </div>
            </div>
        </div>
    );
}

// ============================================================
// Quota Page
// ============================================================
function QuotaPage() {
    const [configs, setConfigs] = useState<QuotaConfig[]>([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState<string | null>(null);
    const [editValues, setEditValues] = useState<Record<string, { free: number; max: number }>>({});
    const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

    useEffect(() => {
        loadConfigs();
    }, []);

    const loadConfigs = async () => {
        setLoading(true);
        try {
            const data = await adminFetch('/api/admin/quota');
            if (data.success) {
                setConfigs(data.data);
                // Initialize edit values
                const values: Record<string, { free: number; max: number }> = {};
                for (const cfg of data.data) {
                    values[cfg.biz_code] = { free: cfg.daily_free_limit, max: cfg.daily_max_limit };
                }
                setEditValues(values);
            }
        } catch (e) {
            console.error('Failed to load configs', e);
        } finally {
            setLoading(false);
        }
    };

    const handleSave = async (config: QuotaConfig) => {
        const values = editValues[config.biz_code];
        if (!values) return;

        if (values.max <= values.free) {
            showToast('error', '每日最大调用次数必须大于每日免费调用次数');
            return;
        }

        setSaving(config.biz_code);
        try {
            const data = await adminFetch('/api/admin/quota', {
                method: 'PUT',
                body: JSON.stringify({
                    bizCode: config.biz_code,
                    bizName: config.biz_name,
                    dailyFreeLimit: values.free,
                    dailyMaxLimit: values.max,
                }),
            });

            if (data.success) {
                showToast('success', `${config.biz_name} 限额配置已保存`);
                loadConfigs();
            } else {
                showToast('error', data.error || '保存失败');
            }
        } catch {
            showToast('error', '网络请求失败');
        } finally {
            setSaving(null);
        }
    };

    const showToast = (type: 'success' | 'error', message: string) => {
        setToast({ type, message });
        setTimeout(() => setToast(null), 3000);
    };

    const updateEditValue = (bizCode: string, field: 'free' | 'max', value: number) => {
        setEditValues(prev => ({
            ...prev,
            [bizCode]: { ...prev[bizCode], [field]: value },
        }));
    };

    if (loading) {
        return (
            <div className="flex items-center justify-center h-64">
                <svg className="animate-spin h-8 w-8 text-indigo-500" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
            </div>
        );
    }

    return (
        <div className="space-y-6">
            {/* Page title */}
            <div>
                <h2 className="text-2xl font-bold text-slate-900">限额配置</h2>
                <p className="text-slate-500 text-sm mt-1">配置每个业务功能的每日免费调用次数和最大调用次数</p>
            </div>

            {/* Toast */}
            <AnimatePresence>
                {toast && (
                    <motion.div
                        initial={{ opacity: 0, y: -10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -10 }}
                        className={`fixed top-6 right-6 z-50 px-5 py-3 rounded-xl text-sm font-medium shadow-lg ${
                            toast.type === 'success'
                                ? 'bg-emerald-500 text-white shadow-emerald-500/25'
                                : 'bg-red-500 text-white shadow-red-500/25'
                        }`}
                    >
                        {toast.message}
                    </motion.div>
                )}
            </AnimatePresence>

            {/* Quota Cards */}
            <div className="space-y-4">
                {configs.map((config, index) => {
                    const values = editValues[config.biz_code] || { free: config.daily_free_limit, max: config.daily_max_limit };
                    const isChanged = values.free !== config.daily_free_limit || values.max !== config.daily_max_limit;
                    const isValid = values.max > values.free;

                    return (
                        <motion.div
                            key={config.biz_code}
                            initial={{ opacity: 0, y: 15 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: index * 0.05 }}
                            className="bg-white rounded-2xl border border-slate-100 p-5 shadow-sm"
                        >
                            <div className="flex flex-col sm:flex-row sm:items-center gap-4">
                                {/* Business info */}
                                <div className="flex items-center gap-3 sm:w-48 shrink-0">
                                    <div className={`w-10 h-10 rounded-xl bg-gradient-to-br ${BIZ_GRADIENTS[config.biz_code] || 'from-slate-500 to-slate-400'} flex items-center justify-center text-white shadow-sm`}>
                                        {BIZ_ICONS[config.biz_code] || <Settings size={20} />}
                                    </div>
                                    <div>
                                        <h4 className="font-semibold text-slate-800 text-sm">{config.biz_name}</h4>
                                        <p className="text-[11px] text-slate-400 font-mono">{config.biz_code}</p>
                                    </div>
                                </div>

                                {/* Input fields */}
                                <div className="flex flex-1 items-center gap-4 flex-wrap">
                                    <div className="flex-1 min-w-[140px]">
                                        <label className="block text-[11px] text-slate-400 font-medium mb-1.5">每日免费次数</label>
                                        <input
                                            type="number"
                                            min="0"
                                            value={values.free}
                                            onChange={(e) => updateEditValue(config.biz_code, 'free', parseInt(e.target.value) || 0)}
                                            className="w-full h-10 bg-slate-50 border border-slate-200 rounded-lg px-3 text-sm text-slate-900 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-500/10 transition-all"
                                        />
                                    </div>
                                    <div className="flex-1 min-w-[140px]">
                                        <label className="block text-[11px] text-slate-400 font-medium mb-1.5">每日最大次数</label>
                                        <input
                                            type="number"
                                            min="1"
                                            value={values.max}
                                            onChange={(e) => updateEditValue(config.biz_code, 'max', parseInt(e.target.value) || 1)}
                                            className={`w-full h-10 bg-slate-50 border rounded-lg px-3 text-sm text-slate-900 outline-none focus:ring-2 transition-all ${
                                                !isValid ? 'border-red-300 focus:border-red-400 focus:ring-red-500/10' : 'border-slate-200 focus:border-indigo-400 focus:ring-indigo-500/10'
                                            }`}
                                        />
                                        {!isValid && (
                                            <p className="text-[11px] text-red-500 mt-1">必须大于免费次数</p>
                                        )}
                                    </div>

                                    {/* Save button */}
                                    <div className="shrink-0 self-end">
                                        <button
                                            onClick={() => handleSave(config)}
                                            disabled={!isChanged || !isValid || saving === config.biz_code}
                                            className="h-10 px-5 bg-indigo-500 hover:bg-indigo-600 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5 active:scale-95"
                                        >
                                            {saving === config.biz_code ? (
                                                <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                                                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                                                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                                                </svg>
                                            ) : '保存'}
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </motion.div>
                    );
                })}
            </div>
        </div>
    );
}

// ============================================================
// Admin Layout
// ============================================================
function AdminLayout({ children, currentPage, onNavigate, onLogout }: {
    children: React.ReactNode;
    currentPage: string;
    onNavigate: (page: string) => void;
    onLogout: () => void;
}) {
    const [sidebarOpen, setSidebarOpen] = useState(false);

    const menuItems = [
        { id: 'dashboard', label: '仪表盘', icon: <LayoutDashboard size={20} /> },
        { id: 'quota', label: '限额配置', icon: <Settings size={20} /> },
    ];

    return (
        <div className="min-h-screen bg-slate-50">
            {/* Mobile top bar */}
            <div className="lg:hidden fixed top-0 left-0 right-0 z-30 h-14 bg-white border-b border-slate-200 flex items-center px-4 gap-3">
                <button
                    onClick={() => setSidebarOpen(true)}
                    className="w-9 h-9 rounded-lg bg-slate-100 flex items-center justify-center text-slate-600 hover:bg-slate-200 transition-colors"
                >
                    <Menu size={20} />
                </button>
                <div className="flex items-center gap-2">
                    <div className="w-7 h-7 bg-gradient-to-br from-indigo-500 to-purple-600 rounded-lg flex items-center justify-center">
                        <Shield className="text-white" size={14} />
                    </div>
                    <span className="font-bold text-slate-900 text-sm">管理中心</span>
                </div>
            </div>

            {/* Sidebar overlay (mobile) */}
            <AnimatePresence>
                {sidebarOpen && (
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="lg:hidden fixed inset-0 z-40 bg-black/40 backdrop-blur-sm"
                        onClick={() => setSidebarOpen(false)}
                    />
                )}
            </AnimatePresence>

            {/* Sidebar */}
            <aside className={`
                fixed top-0 left-0 bottom-0 z-50 w-64 bg-slate-900 flex flex-col
                transition-transform duration-300 ease-in-out
                lg:translate-x-0
                ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}
            `}>
                {/* Sidebar header */}
                <div className="h-16 px-5 flex items-center justify-between border-b border-white/[0.06]">
                    <div className="flex items-center gap-3">
                        <div className="w-9 h-9 bg-gradient-to-br from-indigo-500 to-purple-600 rounded-xl flex items-center justify-center shadow-lg shadow-indigo-500/20">
                            <Shield className="text-white" size={18} />
                        </div>
                        <span className="font-bold text-white text-base tracking-tight">管理中心</span>
                    </div>
                    <button
                        onClick={() => setSidebarOpen(false)}
                        className="lg:hidden w-8 h-8 rounded-lg bg-white/10 flex items-center justify-center text-white/60 hover:text-white transition-colors"
                    >
                        <X size={16} />
                    </button>
                </div>

                {/* Menu */}
                <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
                    {menuItems.map(item => (
                        <button
                            key={item.id}
                            onClick={() => { onNavigate(item.id); setSidebarOpen(false); }}
                            className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition-all ${
                                currentPage === item.id
                                    ? 'bg-indigo-500/15 text-indigo-400'
                                    : 'text-slate-400 hover:text-white hover:bg-white/[0.06]'
                            }`}
                        >
                            {item.icon}
                            {item.label}
                        </button>
                    ))}
                </nav>

                {/* Footer */}
                <div className="p-3 border-t border-white/[0.06]">
                    <button
                        onClick={onLogout}
                        className="w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium text-slate-500 hover:text-red-400 hover:bg-red-500/10 transition-all"
                    >
                        <LogOut size={20} />
                        退出登录
                    </button>
                </div>
            </aside>

            {/* Main content */}
            <main className="lg:ml-64 min-h-screen pt-14 lg:pt-0">
                <div className="max-w-6xl mx-auto p-6 lg:p-8">
                    {children}
                </div>
            </main>
        </div>
    );
}

// ============================================================
// Admin App — Main Router
// ============================================================
export default function AdminApp() {
    const [token, setToken] = useState<string | null>(() => getToken());
    const [page, setPage] = useState<string>(() => {
        const hash = window.location.hash;
        if (hash.includes('quota')) return 'quota';
        return 'dashboard';
    });

    useEffect(() => {
        const handleHashChange = () => {
            const hash = window.location.hash;
            if (hash.includes('quota')) setPage('quota');
            else if (hash.includes('dashboard')) setPage('dashboard');
            else if (hash.includes('login')) {
                // If on login route and already authenticated, redirect
            }
        };
        window.addEventListener('hashchange', handleHashChange);
        return () => window.removeEventListener('hashchange', handleHashChange);
    }, []);

    const handleLogin = (t: string) => {
        setToken(t);
        window.location.hash = '#/admin/dashboard';
        setPage('dashboard');
    };

    const handleLogout = () => {
        sessionStorage.removeItem('admin_token');
        setToken(null);
        window.location.hash = '#/admin/login';
    };

    const handleNavigate = (p: string) => {
        setPage(p);
        window.location.hash = `#/admin/${p}`;
    };

    // Not logged in — show login
    if (!token) {
        return <LoginPage onLogin={handleLogin} />;
    }

    // Logged in — show admin layout
    return (
        <AdminLayout currentPage={page} onNavigate={handleNavigate} onLogout={handleLogout}>
            {page === 'dashboard' && <DashboardPage />}
            {page === 'quota' && <QuotaPage />}
        </AdminLayout>
    );
}
