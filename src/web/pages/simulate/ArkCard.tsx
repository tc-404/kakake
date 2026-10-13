import { LayoutTemplate } from 'lucide-react';
import { resolveMediaSrc } from './media-source';

/**
 * QQ 官方 ARK 模板卡片渲染。
 * 结构：{ template_id, kv: [{ key, value?, obj?: [{ obj_kv: [{ key, value }] }] }] }
 * 常见模板 23（文本+链接列表）、24（大图+描述）、37（大图）。
 * 这里通用地把 kv 展开成「标题 / 描述 / 列表 / 图片 / 链接」。
 */
export function ArkCard({ ark }: { ark: Record<string, unknown> }) {
  const templateId = String(ark.template_id ?? ark.templateId ?? '');
  const kvList = Array.isArray(ark.kv) ? (ark.kv as ArkKv[]) : [];
  const flat = flattenKv(kvList);

  const prompt = flat['#PROMPT#'] || flat['#DESC#'];
  const title = flat['#METATITLE#'] || flat['#TITLE#'] || flat['#METACOVERTITLE#'];
  const desc = flat['#METASUBTITLE#'] || flat['#METADESC#'] || flat['#SUBTITLE#'];
  const img = flat['#METACOVER#'] || flat['#IMAGE#'] || flat['#IMG#'] || flat['#METAICON#'];
  const link = flat['#METAURL#'] || flat['#LINK#'] || flat['#JUMP_URL#'];
  const imgSrc = img ? resolveMediaSrc(img, 'image/png') : null;

  // 列表型（模板 23）：obj 里每行一个 desc + link
  const listRows = extractListRows(kvList);

  const content = (
    <div className="w-[min(17rem,100%)] overflow-hidden rounded-xl border border-sky-200/60 bg-white/60">
      <div className="flex items-center gap-1 border-b border-sky-100/70 bg-sky-500/8 px-2.5 py-1 text-[10px] font-medium text-sky-700">
        <LayoutTemplate className="h-3 w-3" /> ARK 卡片{templateId ? ` · 模板 ${templateId}` : ''}
      </div>
      {imgSrc ? (
        <img src={imgSrc} alt="卡片图" className="max-h-40 w-full object-cover" />
      ) : null}
      <div className="flex flex-col gap-1 p-2.5">
        {title ? <div className="text-sm font-semibold text-slate-800">{title}</div> : null}
        {desc ? <div className="text-[12px] text-slate-500">{desc}</div> : null}
        {listRows.length > 0 ? (
          <div className="mt-1 flex flex-col gap-1">
            {listRows.map((row, i) => (
              <div key={i} className="rounded-md bg-white/60 px-2 py-1 text-[12px] text-slate-600">{row}</div>
            ))}
          </div>
        ) : null}
        {!title && !desc && listRows.length === 0 && prompt ? (
          <div className="text-[12px] text-slate-600">{prompt}</div>
        ) : null}
      </div>
    </div>
  );

  if (link) {
    return (
      <a href={link} target="_blank" rel="noreferrer" className="block transition-transform active:scale-[0.99]">
        {content}
      </a>
    );
  }
  return content;
}

type ArkKv = {
  key?: string;
  value?: string;
  obj?: Array<{ obj_kv?: Array<{ key?: string; value?: string }> }>;
};

/** 顶层 kv 平铺成 { key: value } */
function flattenKv(kv: ArkKv[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of kv) {
    if (item.key && typeof item.value === 'string') out[item.key] = item.value;
  }
  return out;
}

/** 从含 obj 的 kv 里抽出列表行文本（模板 23 的 #LIST# 等） */
function extractListRows(kv: ArkKv[]): string[] {
  const rows: string[] = [];
  for (const item of kv) {
    if (!Array.isArray(item.obj)) continue;
    for (const obj of item.obj) {
      if (!Array.isArray(obj.obj_kv)) continue;
      const text = obj.obj_kv
        .map((o) => (typeof o.value === 'string' ? o.value : ''))
        .filter(Boolean)
        .join(' ');
      if (text) rows.push(text);
    }
  }
  return rows;
}
