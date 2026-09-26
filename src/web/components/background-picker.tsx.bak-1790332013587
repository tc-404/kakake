import { useRef, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import {
  BACKGROUND_ACCEPT,
  backgroundKindFromFile,
  backgroundMaxBytesOf,
  isSupportedBackgroundFile,
  type BackgroundKind,
  type BackgroundOrientation,
} from '@/lib/appearance';

const ORIENTATION_LABEL: Record<BackgroundOrientation, string> = {
  portrait: '竖屏背景图',
  landscape: '横屏背景图',
};

/** 选择器卡片里正在展示的那份预览：本地草稿或已保存资源 */
export interface BackgroundPreview {
  url: string;
  kind: BackgroundKind;
}

/** 竖屏 9:16、横屏 16:9；等高排布，宽度由比例决定，卡片形状本身即是说明 */
const SHAPE: Record<BackgroundOrientation, string> = {
  portrait: 'aspect-[9/16]',
  landscape: 'aspect-[16/9]',
};

function BackgroundCard({
  orientation,
  preview,
  disabled,
  onPick,
  onClear,
}: {
  orientation: BackgroundOrientation;
  preview: BackgroundPreview | null;
  disabled?: boolean;
  onPick: (file: File) => void;
  onClear: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const label = ORIENTATION_LABEL[orientation];

  const accept = (file: File | undefined | null) => {
    if (!file) return;
    if (!isSupportedBackgroundFile(file)) {
      toast.error('不支持该文件格式');
      return;
    }
    const kind = backgroundKindFromFile(file);
    if (file.size > backgroundMaxBytesOf(kind)) {
      toast.error(kind === 'video' ? '视频超过 100MB' : '图片超过 10MB');
      return;
    }
    onPick(file);
  };

  const openPicker = () => {
    if (disabled) return;
    inputRef.current?.click();
  };

  return (
    <div
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-label={label}
      aria-disabled={disabled || undefined}
      className={cn(
        'kk-bg-card h-[9.5rem] sm:h-[11.5rem]',
        SHAPE[orientation],
        preview && 'kk-bg-card--filled',
        dragOver && 'kk-bg-card--drop',
        disabled && 'pointer-events-none opacity-60',
      )}
      onClick={openPicker}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        openPicker();
      }}
      onDragEnter={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragOver={(e) => {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
        setDragOver(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setDragOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        accept(e.dataTransfer?.files?.[0]);
      }}
    >
      {preview ? (
        preview.kind === 'video' ? (
          <video
            src={preview.url}
            className="kk-bg-card__img"
            autoPlay
            loop
            muted
            playsInline
            ref={(el) => {
              if (el) el.muted = true;
            }}
          />
        ) : (
          <img src={preview.url} alt="" className="kk-bg-card__img" draggable={false} />
        )
      ) : null}

      <span aria-hidden className="kk-bg-card__plus">
        <Plus className="h-6 w-6" strokeWidth={2.4} />
      </span>

      {preview ? (
        <button
          type="button"
          aria-label={`移除${label}`}
          className="kk-bg-card__clear"
          onClick={(e) => {
            e.stopPropagation();
            onClear();
          }}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      ) : null}

      <input
        ref={inputRef}
        type="file"
        accept={BACKGROUND_ACCEPT}
        className="sr-only"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => {
          accept(e.target.files?.[0]);
          // 同一文件再次选择也要触发 change
          e.target.value = '';
        }}
      />
    </div>
  );
}

/**
 * 自定义背景选择：竖屏与横屏各一份，互不相干，图片与视频（mp4 / 实况图）都可。
 * 点击卡片选文件，或直接把文件拖到卡片上（拖入时卡片高亮）。
 */
export function BackgroundPicker({
  previews,
  disabled,
  onPick,
  onClear,
}: {
  previews: Record<BackgroundOrientation, BackgroundPreview | null>;
  disabled?: boolean;
  onPick: (orientation: BackgroundOrientation, file: File) => void;
  onClear: (orientation: BackgroundOrientation) => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-center gap-4">
      <BackgroundCard
        orientation="portrait"
        preview={previews.portrait}
        disabled={disabled}
        onPick={(file) => onPick('portrait', file)}
        onClear={() => onClear('portrait')}
      />
      <BackgroundCard
        orientation="landscape"
        preview={previews.landscape}
        disabled={disabled}
        onPick={(file) => onPick('landscape', file)}
        onClear={() => onClear('landscape')}
      />
    </div>
  );
}