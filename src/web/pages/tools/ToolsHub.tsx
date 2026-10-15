import { useNavigate } from 'react-router-dom';
import { TOOLS_REGISTRY } from '@/lib/tools-registry';

export default function ToolsHub() {
  const navigate = useNavigate();

  return (
    <div className="flex h-full min-h-0 w-full flex-col gap-4 md:gap-5">
      {/* 「工具」标题已由顶栏显示，这里直接从工具卡片开始 */}
      <div data-tour="tools-grid" className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {TOOLS_REGISTRY.map((tool) => {
          const Icon = tool.icon;
          return (
            <button
              key={tool.id}
              type="button"
              data-tour={`tool-${tool.id}`}
              onClick={() => navigate(`/tools/${tool.id}`)}
              className="kk-glass group flex flex-col items-start gap-3 rounded-2xl p-4 text-left transition hover:border-teal-400/40 hover:bg-white/55 hover:shadow-[var(--glass-shadow-hover)]"
            >
              <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-teal-500/15 text-teal-700 ring-1 ring-teal-500/20 transition group-hover:bg-teal-500/25">
                <Icon className="h-5 w-5" />
              </span>
              <div className="min-w-0">
                <h2 className="text-base font-semibold text-slate-800">{tool.title}</h2>
                <p className="mt-1 text-sm leading-relaxed text-slate-500">{tool.description}</p>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
