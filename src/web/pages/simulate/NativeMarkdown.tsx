import { useState } from 'react';
import { FileCode2 } from 'lucide-react';
import { resolveMediaSrc } from './media-source';
import { ImageLightbox } from './MediaViewer';

/**
 * QQ 官方原生 Markdown 消息渲染。
 * 两种形态：
 *  - 自由文本：{ content: "# 标题\n正文..." }
 *  - 模板：{ custom_template_id, params: [{ key, values: [...] }] }（无原文，仅展示占位）
 * 附带 keyboard（按钮）时，把按钮渲染成不可点的样式化标签。
 */
export function NativeMarkdown({
  markdown,
  keyboard,
}: {
  markdown: Record<string, unknown> | string;
  keyboard?: Record<string, unknown>;
}) {
  const md = typeof markdown === 'string' ? { content: markdown } : markdown;
  const content = typeof md.content === 'string' ? md.content : '';
  const templateId = md.custom_template_id ?? md.customTemplateId;
  const params = Array.isArray(md.params) ? (md.params as Array<{ key?: string; values?: string[] }>) : [];

  return (
    <div className="flex w-[min(19rem,100%)] flex-col gap-1.5 overflow-hidden rounded-xl border border-violet-200/60 bg-white/55 p-2.5">
      <div className="flex items-center gap-1 text-[10px] font-medium text-violet-700">
        <FileCode2 className="h-3 w-3" /> 原生 Markdown{templateId ? ` · 模板 ${templateId}` : ''}
      </div>

      {content ? (
        <MarkdownBody text={content} />
      ) : params.length > 0 ? (
        <div className="flex flex-col gap-0.5">
          {params.map((p, i) => (
            <div key={i} className="text-[12px] text-slate-600">
              <span className="text-slate-400">{p.key}：</span>
              {(p.values ?? []).join(', ')}
            </div>
          ))}
        </div>
      ) : (
        <div className="text-[12px] text-slate-400">（空 Markdown）</div>
      )}

      {keyboard ? <KeyboardButtons keyboard={keyboard} /> : null}
    </div>
  );
}

/** 轻量 Markdown 渲染：标题、粗体、行内代码、链接、图片、列表。不引三方库。 */
function MarkdownBody({ text }: { text: string }) {
  const [zoomSrc, setZoomSrc] = useState<string | null>(null);
  const lines = text.replace(/\r\n/g, '\n').split('\n');

  return (
    <div className="flex flex-col gap-1 text-sm text-slate-800">
      {lines.map((line, i) => {
        const trimmed = line.trim();
        if (!trimmed) return <div key={i} className="h-1" />;

        // 图片 ![alt](url)
        const img = /^!\[[^\]]*\]\(([^)]+)\)$/.exec(trimmed);
        if (img) {
          const src = resolveMediaSrc(img[1], 'image/png');
          if (src) {
            return (
              <img
                key={i}
                src={src}
                alt="md"
                className="max-h-44 max-w-full cursor-zoom-in rounded-lg object-contain"
                onClick={() => setZoomSrc(src)}
              />
            );
          }
        }

        // 标题
        const h = /^(#{1,6})\s+(.*)$/.exec(trimmed);
        if (h) {
          const level = h[1].length;
          return (
            <div key={i} className={level <= 2 ? 'text-[15px] font-bold' : 'text-sm font-semibold'}>
              {renderInline(h[2])}
            </div>
          );
        }

        // 列表
        const li = /^[-*+]\s+(.*)$/.exec(trimmed);
        if (li) {
          return (
            <div key={i} className="flex gap-1.5 pl-1">
              <span className="text-slate-400">•</span>
              <span>{renderInline(li[1])}</span>
            </div>
          );
        }

        // 引用
        const quote = /^>\s?(.*)$/.exec(trimmed);
        if (quote) {
          return (
            <div key={i} className="border-l-2 border-violet-300 pl-2 text-slate-500">{renderInline(quote[1])}</div>
          );
        }

        return <div key={i} className="break-words break-all">{renderInline(line)}</div>;
      })}
      {zoomSrc && <ImageLightbox src={zoomSrc} onClose={() => setZoomSrc(null)} />}
    </div>
  );
}

/** 行内：**粗体**、`代码`、[文本](链接) */
function renderInline(text: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  const regex = /(\*\*([^*]+)\*\*)|(`([^`]+)`)|(\[([^\]]+)\]\(([^)]+)\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let idx = 0;
  while ((m = regex.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    if (m[2] !== undefined) {
      parts.push(<strong key={idx++}>{m[2]}</strong>);
    } else if (m[4] !== undefined) {
      parts.push(<code key={idx++} className="rounded bg-black/10 px-1 text-[12px]">{m[4]}</code>);
    } else if (m[6] !== undefined) {
      parts.push(
        <a key={idx++} href={m[7]} target="_blank" rel="noreferrer" className="text-sky-600 underline underline-offset-2">
          {m[6]}
        </a>,
      );
    }
    last = regex.lastIndex;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

/** 官方 keyboard：把按钮排出来（模拟里不可真正点击） */
function KeyboardButtons({ keyboard }: { keyboard: Record<string, unknown> }) {
  const content = (keyboard.content ?? keyboard) as Record<string, unknown>;
  const rows = Array.isArray(content?.rows) ? (content.rows as Array<{ buttons?: ButtonDef[] }>) : [];
  if (rows.length === 0) return null;

  return (
    <div className="mt-1 flex flex-col gap-1.5 border-t border-violet-100/70 pt-2">
      {rows.map((row, i) => (
        <div key={i} className="flex flex-wrap gap-1.5">
          {(row.buttons ?? []).map((btn, j) => (
            <span
              key={j}
              className="rounded-lg border border-violet-200 bg-violet-500/10 px-2.5 py-1 text-[12px] text-violet-700"
              title="模拟按钮（不可点击）"
            >
              {btn.render_data?.label ?? btn.render_data?.visited_label ?? '按钮'}
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}

type ButtonDef = {
  render_data?: { label?: string; visited_label?: string };
};
