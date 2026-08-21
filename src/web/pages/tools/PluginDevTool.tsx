import { useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { api } from '@/lib/api';
import { CodeFileBlock } from '@/pages/tools/plugin-dev/CodeFileBlock';

type Track = {
  id: string;
  label: string;
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
  tracks: Track[];
};

export default function PluginDevTool() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [data, setData] = useState<Payload | null>(null);
  const [trackId, setTrackId] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError('');
      try {
        const res = await api.tutorials.pluginDev();
        if (cancelled) return;
        const payload = res.data;
        setData(payload);
        setTrackId(payload.tracks[0]?.id || '');
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

  const active = useMemo(
    () => data?.tracks.find((t) => t.id === trackId) || data?.tracks[0],
    [data, trackId],
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

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 pb-4">
      <article className="kk-glass kk-md-prose rounded-2xl px-4 py-4 text-slate-800 sm:px-5 sm:py-5">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{data.introMarkdown}</ReactMarkdown>
      </article>

      <div className="flex flex-wrap gap-2">
        {data.tracks.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTrackId(t.id)}
            className={cn(
              'rounded-full px-3 py-1.5 text-sm font-medium transition',
              (active?.id || '') === t.id
                ? 'bg-teal-500/90 text-white shadow-sm'
                : 'bg-white/35 text-slate-600 hover:bg-white/55',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {active ? (
        <div className="flex flex-col gap-4">
          <article className="kk-glass kk-md-prose rounded-2xl px-4 py-4 text-slate-800 sm:px-5 sm:py-5">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{active.guideMarkdown}</ReactMarkdown>
          </article>

          {active.files.map((f) => (
            <div key={f.path} className="flex flex-col gap-2">
              {f.heading ? (
                <h3 className="px-1 text-sm font-semibold text-slate-800 sm:text-base">
                  {f.heading}
                </h3>
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
