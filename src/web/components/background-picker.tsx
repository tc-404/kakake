import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import {
  BACKGROUND_ACCEPT,
  backgroundKindFromFile,
  backgroundMaxBytesOf,
  isSupportedBackgroundFile,
  type BackgroundKind,
  type BackgroundOrientation,
} from '@/lib/appearance';

/** 存 i18n key 而不是文案：切换语言时 ARIA 标签也要跟着变 */
const ORIENTATION_LABEL_KEY: Record<BackgroundOrientation, string> = {
  portrait: 'settings.bgPortrait',
  landscape: 'settings.bgLandscape',
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
  selected,
  onPick,
  onClear,
  onLongPress,
}: {
  orientation: BackgroundOrientation;
  preview: BackgroundPreview | null;
  disabled?: boolean;
  selected?: boolean;
  onPick: (file: File) => void;
  onClear: () => void;
  onLongPress?: (orientation: BackgroundOrientation) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressAt = useRef(0);
  const [dragOver, setDragOver] = useState(false);
  const [arming, setArming] = useState(false);
  const t = useT();
  const label = t(ORIENTATION_LABEL_KEY[orientation]);

  const clearPress = () => {
    if (pressTimer.current) {
      clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
    setArming(false);
  };

  const startPress = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled || !preview || !onLongPress) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    clearPress();
    longPressAt.current = 0;
    setArming(true);
    pressTimer.current = setTimeout(() => {
      pressTimer.current = null;
      longPressAt.current = Date.now();
      setArming(false);
      onLongPress(orientation);
    }, 3000);
  };

  /**
   * 视频预览只当「封面缩略图」：不自动播放、不循环，只解出首帧显示。
   * 全屏背景已有 <AmbientVideo /> 在实时播放；选择器卡片若再各自 autoPlay+loop，
   * 设置页就会同时跑 3 路（全屏 1 + 竖横预览 2）视频解码、且默认 preload=auto 会把
   * 整段视频（最大 100MB）全缓冲进内存——这正是「只有设置页卡顿、且担心内存溢出」的原因。
   */
  const showVideoFirstFrame = useCallback((el: HTMLVideoElement | null) => {
    if (!el) return;
    el.muted = true;
    const seek = () => {
      // seek 到极靠前的位置即可让暂停态渲染出画面，无需持续解码
      try {
        if (el.currentTime < 0.05) el.currentTime = 0.05;
      } catch {
        /* 个别格式不支持精确 seek，退化为黑帧，忽略 */
      }
    };
    if (el.readyState >= 1) seek();
    else el.addEventListener('loadedmetadata', seek, { once: true });
  }, []);

  const accept = (file: File | undefined | null) => {
    if (!file) return;
    if (!isSupportedBackgroundFile(file)) {
      toast.error(t('settings.bgUnsupported'));
      return;
    }
    const kind = backgroundKindFromFile(file);
    if (file.size > backgroundMaxBytesOf(kind)) {
      toast.error(kind === 'video' ? t('settings.bgVideoTooBig') : t('settings.bgImageTooBig'));
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
        selected && 'kk-bg-card--selected',
        arming && 'kk-bg-card--arming',
        disabled && 'pointer-events-none opacity-60',
      )}
      onClick={() => {
        if (Date.now() - longPressAt.current < 1000) {
          longPressAt.current = 0;
          return;
        }
        openPicker();
      }}
      onPointerDown={startPress}
      onPointerUp={clearPress}
      onPointerLeave={clearPress}
      onPointerCancel={clearPress}
      onContextMenu={(e) => e.preventDefault()}
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
            muted
            playsInline
            preload="metadata"
            aria-hidden
            tabIndex={-1}
            ref={showVideoFirstFrame}
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
          aria-label={t('settings.bgRemoveAria', { label })}
          className="kk-bg-card__clear"
          onPointerDown={(e) => e.stopPropagation()}
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
  selected,
  onPick,
  onClear,
  onLongPress,
}: {
  previews: Record<BackgroundOrientation, BackgroundPreview | null>;
  disabled?: boolean;
  selected?: BackgroundOrientation | null;
  onPick: (orientation: BackgroundOrientation, file: File) => void;
  onClear: (orientation: BackgroundOrientation) => void;
  onLongPress?: (orientation: BackgroundOrientation) => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-center gap-4">
      <BackgroundCard
        orientation="portrait"
        preview={previews.portrait}
        disabled={disabled}
        selected={selected === 'portrait'}
        onLongPress={onLongPress}
        onPick={(file) => onPick('portrait', file)}
        onClear={() => onClear('portrait')}
      />
      <BackgroundCard
        orientation="landscape"
        preview={previews.landscape}
        disabled={disabled}
        selected={selected === 'landscape'}
        onLongPress={onLongPress}
        onPick={(file) => onPick('landscape', file)}
        onClear={() => onClear('landscape')}
      />
    </div>
  );
}