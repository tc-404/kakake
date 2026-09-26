import * as React from 'react';
import { ColorArea } from '@/components/color-dial';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import {
  COLOR_ROLES,
  hsvPatch,
  hsvToHex,
  parseColorToHsv,
  readHsv,
  roleSampleColor,
  type AppearanceSettings,
  type ColorRole,
  type Hsv,
} from '@/lib/appearance';

const ROLE_LABEL: Record<ColorRole, string> = {
  ink: '全局字体',
  comp: '组件及按钮',
  logo: '品牌 Logo',
};

const ROLE_HINT: Record<ColorRole, string> = {
  ink: '正文、标题等文字的主色',
  comp: '按钮、开关、高亮等组件色',
  logo: '顶部品牌标识渐变色',
};

/**
 * 配色方案：一行一个角色，行尾一个正方形色块预览当前色。
 * 点色块弹出悬浮窗里的拾色盘，拖动选色，点「确定」立即生效并落库。
 */
export function ColorPanel({
  settings,
  disabled,
  onChange,
}: {
  settings: AppearanceSettings;
  disabled?: boolean;
  onChange: (patch: Partial<AppearanceSettings>) => void;
}) {
  return (
    <div className="flex flex-col divide-y divide-white/30">
      {COLOR_ROLES.map((role) => (
        <ColorRow
          key={role}
          role={role}
          settings={settings}
          disabled={disabled}
          onConfirm={(hsv) => onChange(hsvPatch(role, hsv))}
        />
      ))}
    </div>
  );
}

function ColorRow({
  role, settings, disabled, onConfirm,
}: {
  role: ColorRole;
  settings: AppearanceSettings;
  disabled?: boolean;
  onConfirm: (hsv: Hsv) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [draft, setDraft] = React.useState<Hsv>(() => readHsv(settings, role));
  // 手填的颜色代码文本（可能正在输入、尚未合法）
  const [hexText, setHexText] = React.useState('');
  const [hexError, setHexError] = React.useState(false);

  // 每次打开时用当前已保存值初始化草稿与输入框
  React.useEffect(() => {
    if (open) {
      const hsv = readHsv(settings, role);
      setDraft(hsv);
      setHexText(hsvToHex(hsv));
      setHexError(false);
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // 色盘拖动后同步刷新输入框（避免与手动输入打架：仅在文本非聚焦编辑态时跟随）
  const setDraftFromWheel = (hsv: Hsv) => {
    setDraft(hsv);
    setHexText(hsvToHex(hsv));
    setHexError(false);
  };

  // 手填颜色代码：实时解析，合法即更新色盘
  const onHexInput = (text: string) => {
    setHexText(text);
    const parsed = parseColorToHsv(text);
    if (parsed) {
      setDraft(parsed);
      setHexError(false);
    } else {
      setHexError(true);
    }
  };

  const confirm = () => {
    onConfirm(draft);
    setOpen(false);
  };

  return (
    <div className="flex items-center gap-3 py-3">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-slate-700">{ROLE_LABEL[role]}</div>
        <div className="text-[11px] text-slate-400">{ROLE_HINT[role]}</div>
      </div>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(true)}
        aria-label={`调整${ROLE_LABEL[role]}颜色`}
        className="h-9 w-9 shrink-0 rounded-lg border border-white/60 shadow-sm ring-1 ring-black/5 transition active:scale-95 disabled:opacity-50"
        style={{ background: roleSampleColor(settings, role) }}
      />

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-[20rem]">
          <DialogHeader>
            <DialogTitle>{ROLE_LABEL[role]}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col items-center gap-3 py-1">
            <ColorArea hsv={draft} disabled={disabled} onChange={setDraftFromWheel} />

            {/* 颜色代码手填：支持 #rrggbb / rgb() / hsl() */}
            <div className="flex items-center gap-2 self-stretch">
              <span
                className="h-9 w-9 shrink-0 rounded-lg border border-white/60 shadow-sm"
                style={{ background: hsvToHex(draft) }}
              />
              <Input
                value={hexText}
                disabled={disabled}
                spellCheck={false}
                autoCapitalize="off"
                placeholder="#66CCFF / rgb(102,204,255)"
                aria-invalid={hexError || undefined}
                onChange={(e) => onHexInput(e.target.value)}
                className={cn('h-9 flex-1 font-mono text-sm', hexError && 'border-rose-400 focus-visible:ring-rose-400/50')}
              />
            </div>
            <div className="self-stretch text-[11px] tabular-nums text-slate-400">
              {hexError
                ? <span className="text-rose-500">无法识别的颜色代码</span>
                : `H ${Math.round(draft.h)}° · S ${Math.round(draft.s)} · V ${Math.round(draft.v)}`}
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>取消</Button>
            <Button type="button" onClick={confirm}>确定</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
