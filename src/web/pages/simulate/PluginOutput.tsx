import { useState } from 'react';
import { MessageSegments } from './MessageSegments';

/** 是否为「发消息」类动作（走气泡）；否则视为系统动作（走灰字） */
export function isMessageAction(action: string): boolean {
  const a = action.toLowerCase();
  if (a.includes('forward')) return true;
  return a.includes('send') && a.includes('msg');
}

/** 系统类动作的灰字摘要（撤回/禁言/踢人/戳一戳/改名片等） */
export function systemActionSummary(action: string, p: Record<string, unknown>): string {
  const a = action.toLowerCase();
  const s = actionSummary(a, p);
  if (s) return `[插件] ${s}`;
  return `[插件] 调用 ${action}`;
}

/** 把插件捕获到的一次 action 调用渲染成可读输出 */
export function PluginOutput({
  action,
  params,
}: {
  action: string;
  params: Record<string, unknown>;
}) {
  const a = action.toLowerCase();

  // 发消息类：直接渲染 message 富媒体
  if (a.includes('send') && a.includes('msg')) {
    return (
      <div className="flex flex-col gap-1">
        <ActionLabel action={action} target={describeTarget(params)} />
        <MessageSegments message={params.message} />
      </div>
    );
  }

  // 合并转发
  if (a.includes('forward')) {
    return (
      <div className="flex flex-col gap-1">
        <ActionLabel action={action} target={describeTarget(params)} />
        <MessageSegments message={params.messages ?? params.message} />
      </div>
    );
  }

  // 撤回 / 禁言 / 戳一戳等：给个动作摘要
  const summary = actionSummary(a, params);
  if (summary) {
    return (
      <div className="flex flex-col gap-1">
        <ActionLabel action={action} />
        <span className="text-sm text-slate-600">{summary}</span>
      </div>
    );
  }

  // 其它 API：折叠原始参数
  return <RawAction action={action} params={params} />;
}

function ActionLabel({ action, target }: { action: string; target?: string }) {
  return (
    <div className="text-[11px] font-medium text-teal-600/80">
      {action}
      {target ? ` · ${target}` : ''}
    </div>
  );
}

function describeTarget(params: Record<string, unknown>): string {
  if (params.group_id) return `群 ${params.group_id}`;
  if (params.user_id) return `私聊 ${params.user_id}`;
  return '';
}

function actionSummary(a: string, p: Record<string, unknown>): string | null {
  if (a.includes('delete_msg') || a.includes('recall')) return `撤回消息 ${p.message_id ?? ''}`;
  if (a.includes('ban')) {
    if (a.includes('whole')) return `全员禁言 ${p.enable === false ? '解除' : '开启'}`;
    return `禁言 ${p.user_id ?? ''} ${p.duration ?? 0} 秒`;
  }
  if (a.includes('kick')) return `踢出 ${p.user_id ?? ''}`;
  if (a.includes('poke')) return `戳一戳 ${p.user_id ?? ''}`;
  if (a.includes('set_group_card')) return `改群名片 ${p.user_id ?? ''} → ${p.card ?? ''}`;
  if (a.includes('set_group_name')) return `改群名 → ${p.group_name ?? ''}`;
  if (a.includes('set_group_special_title')) return `设头衔 ${p.user_id ?? ''} → ${p.special_title ?? ''}`;
  return null;
}

function RawAction({ action, params }: { action: string; params: Record<string, unknown> }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="self-start text-[11px] font-medium text-teal-600/80 hover:text-teal-700"
      >
        {action} {open ? '▾' : '▸'}
      </button>
      {open && (
        <pre className="max-w-full overflow-x-auto rounded bg-slate-900/80 p-2 text-[11px] text-slate-100">
          {JSON.stringify(params, null, 2)}
        </pre>
      )}
    </div>
  );
}
