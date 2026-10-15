import { useState } from 'react';
import { FileText, Image as ImageIcon } from 'lucide-react';
import { resolveMediaSrc } from './media-source';
import { ImageLightbox } from './MediaViewer';
import { NativeMarkdown } from './NativeMarkdown';
import { ArkCard } from './ArkCard';

/**
 * QQ 官方机器人输出渲染。
 * 官方发消息接口 path 里含 /messages；msg_type 决定形态：
 *   0 文本 / 2 markdown / 3 ark / 4 embed / 7 media(富媒体)。
 */
export function isOfficialMessageAction(action: string, params: Record<string, unknown>): boolean {
  const a = String(action || '').toLowerCase();
  if (a.includes('/messages') || a.includes('message')) return true;
  // 有 content / markdown / ark 字段的也当消息
  return params.content !== undefined || params.markdown !== undefined || params.ark !== undefined;
}

function officialTarget(action: string): string {
  const a = action.toLowerCase();
  if (a.includes('/groups/')) return '群';
  if (a.includes('/users/')) return '私聊';
  if (a.includes('/channels/')) return '频道';
  if (a.includes('/dms/')) return '频道私信';
  return '';
}

export function OfficialOutput({
  action,
  params,
}: {
  action: string;
  params: Record<string, unknown>;
}) {
  const msgType = Number(params.msg_type ?? -1);
  const target = officialTarget(action);

  // ARK 卡片
  const ark = (params.ark ?? (msgType === 3 ? params.ark : undefined)) as Record<string, unknown> | undefined;
  // 原生 markdown
  const markdown = params.markdown as Record<string, unknown> | string | undefined;
  const keyboard = params.keyboard as Record<string, unknown> | undefined;
  const content = typeof params.content === 'string' ? params.content : '';
  const media = params.media as Record<string, unknown> | undefined;

  return (
    <div className="flex flex-col gap-1">
      <OfficialLabel action={action} target={target} msgType={msgType} />

      {ark ? <ArkCard ark={ark} /> : null}

      {markdown ? <NativeMarkdown markdown={markdown} keyboard={keyboard} /> : null}

      {media ? <OfficialMedia media={media} /> : null}

      {content ? <div className="whitespace-pre-wrap break-words break-all text-sm text-slate-800">{content}</div> : null}

      {!ark && !markdown && !media && !content ? <RawOfficial params={params} /> : null}
    </div>
  );
}

function OfficialLabel({ action, target, msgType }: { action: string; target: string; msgType: number }) {
  const typeName = MSG_TYPE_LABEL[msgType];
  return (
    <div className="flex items-center gap-1 text-[11px] font-medium text-sky-600/80">
      <span>官方发送{target ? ` · ${target}` : ''}</span>
      {typeName ? <span className="rounded bg-sky-500/12 px-1 py-px text-[10px] text-sky-700">{typeName}</span> : null}
    </div>
  );
}

const MSG_TYPE_LABEL: Record<number, string> = {
  0: '文本',
  2: 'Markdown',
  3: 'ARK 卡片',
  4: 'Embed',
  7: '富媒体',
};

function OfficialMedia({ media }: { media: Record<string, unknown> }) {
  const [zoom, setZoom] = useState(false);
  const url = resolveMediaSrc(media.url ?? media.file_info ?? media.file, 'image/png');
  if (!url) {
    return (
      <div className="flex items-center gap-1.5 rounded-lg bg-white/40 px-2.5 py-1.5 text-xs text-slate-500">
        <ImageIcon className="h-3.5 w-3.5" /> 富媒体（file_info）
      </div>
    );
  }
  return (
    <>
      <img
        src={url}
        alt="富媒体"
        className="max-h-52 max-w-[min(14rem,100%)] cursor-zoom-in rounded-lg object-contain"
        onClick={() => setZoom(true)}
      />
      {zoom && <ImageLightbox src={url} onClose={() => setZoom(false)} />}
    </>
  );
}

function RawOfficial({ params }: { params: Record<string, unknown> }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 self-start text-[11px] font-medium text-sky-600/80 hover:text-sky-700"
      >
        <FileText className="h-3 w-3" /> 原始参数 {open ? '▾' : '▸'}
      </button>
      {open && (
        <pre className="max-w-full overflow-x-auto rounded bg-slate-900/80 p-2 text-[11px] text-slate-100">
          {JSON.stringify(params, null, 2)}
        </pre>
      )}
    </div>
  );
}
