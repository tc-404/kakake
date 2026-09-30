import { useCallback, useEffect, useMemo, useState } from 'react';
import { MarkdownContent } from '@/components/markdown-content';
import { BookOpen, Braces, ChevronRight, FileCode, FileCode2, Loader2, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { api } from '@/lib/api';
import { CodeFileBlock } from '@/pages/tools/plugin-dev/CodeFileBlock';

type Track = {
  id: string;
  label: string;
  cardTitle: string;
  cardSubtitle: string;
  cardDescription: string;
  dir: string;
  guide: string;
  guideMarkdown: string;
  files: Array<{
    path: string;
    title: string;
    downloadName: string;
    language: string;
    content: string;
    heading?: string;
  }>;
};

type Payload = {
  introMarkdown: string;
  introCard: { title: string; subtitle: string; description: string };
  tracks: Track[];
};

type DocEntry = {
  id: string;
  title: string;
  subtitle: string;
  description: string;
  icon: LucideIcon;
};

/** 首屏卡片与详情页共用同一份 id：intro / <track.id>；写进 URL hash 以便直达与后退 */
const HASH_PREFIX = '#doc=';
const INTRO_ID = 'intro';

function readHashDocId(): string {
  if (typeof window === 'undefined') return '';
  const m = /^#doc=([A-Za-z0-9_-]+)$/.exec(window.location.hash);
  return m ? m[1] : '';
}

export default function PluginDevTool() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [data, setData] = useState<Payload | null>(null);
  const [openId, setOpenId] = useState<string>(() => readHashDocId());

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError('');
      try {
        const res = await api.tutorials.pluginDev();
        if (cancelled) return;
        setData(res.data);
      } catch (e: unknown) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : '加载教程失败');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 浏览器前进 / 后退时跟随 hash 切换文档
  useEffect(() => {
    const sync = () => setOpenId(readHashDocId());
    window.addEventListener('hashchange', sync);
    window.addEventListener('popstate', sync);
    return () => {
      window.removeEventListener('hashchange', sync);
      window.removeEventListener('popstate', sync);
    };
  }, []);

  const openDoc = useCallback((id: string) => {
    if (readHashDocId() === id) {
      setOpenId(id);
      return;
    }
    // 赋值 hash 会推入一条历史记录：浏览器「后退」能回到文档目录
    window.location.hash = `${HASH_PREFIX.slice(1)}${id}`;
    setOpenId(id);
  }, []);

  const entries = useMemo<DocEntry[]>(() => {
    if (!data) return [];
    const intro: DocEntry = {
      id: INTRO_ID,
      title: data.introCard?.title || '总览',
      subtitle: data.introCard?.subtitle || '前言',
      description: data.introCard?.description || '',
      icon: BookOpen,
    };
    return [
      intro,
      ...data.tracks.map((t) => ({
        id: t.id,
        title: t.cardTitle || t.label || t.id,
        subtitle: t.cardSubtitle || t.label || '',
        description: t.cardDescription || '',
        icon: t.id === 'typescript' ? FileCode2 : t.id.includes('cjs') ? Braces : FileCode,
      })),
    ];
  }, [data]);

  const current = useMemo(() => entries.find((e) => e.id === openId) || null, [entries, openId]);
  const currentTrack = useMemo(
    () => (current && current.id !== INTRO_ID ? data?.tracks.find((t) => t.id === current.id) || null : null),
    [current, data],
  );

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center py-16 text-slate-500">
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="kk-glass rounded-2xl px-4 py-6 text-sm text-rose-700">
        {error || '教程文件未找到'}
      </div>
    );
  }

  // ==================== 首屏：选一份文档 ====================
  if (!current) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-4 pb-4">
        <div className="kk-glass rounded-2xl px-4 py-4 sm:px-5 sm:py-5">
          <h2 className="text-base font-semibold text-slate-800">插件开发教程</h2>
          <p className="mt-1 text-sm leading-relaxed text-slate-500">
            {entries.length} 份文档，按需要选一份。第一次写插件建议先看「{data.introCard?.title || '总览'}」，再从下面三条轨里挑一条动手：野鸡 TS 开发写源码再构建，野鸡 JS 开发（ESM 版）直接改 <code>.mjs</code> 就能跑，野鸡 JS 开发（CJS 版）是同一套东西的 <code>require</code> 写法（老插件移植选它）。
          </p>
        </div>

        <div className="flex flex-col gap-3">
          {entries.map((entry) => {
            const Icon = entry.icon;
            return (
              <button
                key={entry.id}
                type="button"
                onClick={() => openDoc(entry.id)}
                className={cn(
                  'kk-glass kk-glass-interactive group flex w-full items-start gap-3.5 rounded-2xl border border-white/40 p-4 text-left',
                  'hover:border-teal-400/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500/40',
                )}
              >
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-teal-500/15 text-teal-700 ring-1 ring-teal-500/20 transition group-hover:bg-teal-500/25">
                  <Icon className="h-5 w-5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <span className="text-base font-semibold text-slate-800">{entry.title}</span>
                    {entry.subtitle ? (
                      <span className="text-xs text-slate-500">{entry.subtitle}</span>
                    ) : null}
                  </span>
                  {entry.description ? (
                    <span className="mt-1 block text-sm leading-relaxed text-slate-500">
                      {entry.description}
                    </span>
                  ) : null}
                </span>
                <ChevronRight className="mt-3 h-4 w-4 shrink-0 text-slate-400 transition group-hover:translate-x-0.5 group-hover:text-teal-600" />
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  // ==================== 详情：总览 / 某一条轨 ====================
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 pb-4">
      <article className="kk-glass rounded-2xl px-4 py-4 text-slate-800 sm:px-5 sm:py-5">
        <MarkdownContent markdown={currentTrack ? currentTrack.guideMarkdown : data.introMarkdown} />
      </article>

      {currentTrack?.files.length ? (
        <div className="flex flex-col gap-4">
          {currentTrack.files.map((f) => (
            <div key={f.path} className="flex flex-col gap-2">
              {f.heading ? (
                <h3 className="px-1 text-sm font-semibold text-slate-800 sm:text-base">{f.heading}</h3>
              ) : null}
              <CodeFileBlock
                title={f.title}
                downloadName={f.downloadName}
                language={f.language}
                content={f.content}
              />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
