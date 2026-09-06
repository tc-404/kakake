export type MediaKind = 'image' | 'video' | 'audio';

export type MediaDetect = {
  kind: MediaKind;
  mime: string;
};

const TEXT_EXT = new Set([
  '.txt',
  '.json',
  '.md',
  '.csv',
  '.xml',
  '.html',
  '.htm',
  '.js',
  '.ts',
  '.tsx',
  '.jsx',
  '.css',
  '.svg',
  '.yml',
  '.yaml',
  '.log',
  '.ini',
  '.conf',
  '.env',
]);

export function stripDataUrlBase64(s: string): string {
  const trimmed = s.trim();
  const m = /^data:[^;]+;base64,(.*)$/is.exec(trimmed);
  return (m ? m[1]! : trimmed).replace(/\s+/g, '');
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(stripDataUrlBase64(b64));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function startsWith(bytes: Uint8Array, sig: number[], offset = 0): boolean {
  if (bytes.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i++) {
    if (bytes[offset + i] !== sig[i]) return false;
  }
  return true;
}

function asciiAt(bytes: Uint8Array, offset: number, text: string): boolean {
  if (bytes.length < offset + text.length) return false;
  for (let i = 0; i < text.length; i++) {
    if (bytes[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

function isMp3FrameSync(bytes: Uint8Array): boolean {
  if (bytes.length < 2) return false;
  const b0 = bytes[0]!;
  const b1 = bytes[1]!;
  return b0 === 0xff && (b1 & 0xe0) === 0xe0;
}

/** 按文件头魔数识别图片 / 视频 / 音频；无法识别返回 null */
export function detectMediaKind(bytes: Uint8Array): MediaDetect | null {
  if (bytes.length < 4) return null;

  // PNG
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { kind: 'image', mime: 'image/png' };
  }
  // JPEG
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return { kind: 'image', mime: 'image/jpeg' };
  }
  // GIF
  if (asciiAt(bytes, 0, 'GIF87a') || asciiAt(bytes, 0, 'GIF89a')) {
    return { kind: 'image', mime: 'image/gif' };
  }
  // WEBP: RIFF....WEBP
  if (asciiAt(bytes, 0, 'RIFF') && asciiAt(bytes, 8, 'WEBP')) {
    return { kind: 'image', mime: 'image/webp' };
  }
  // BMP
  if (startsWith(bytes, [0x42, 0x4d])) {
    return { kind: 'image', mime: 'image/bmp' };
  }

  // WAV: RIFF....WAVE
  if (asciiAt(bytes, 0, 'RIFF') && asciiAt(bytes, 8, 'WAVE')) {
    return { kind: 'audio', mime: 'audio/wav' };
  }
  // FLAC
  if (asciiAt(bytes, 0, 'fLaC')) {
    return { kind: 'audio', mime: 'audio/flac' };
  }
  // OGG (can be audio/video; treat as audio for preview)
  if (asciiAt(bytes, 0, 'OggS')) {
    return { kind: 'audio', mime: 'audio/ogg' };
  }
  // MP3 ID3 or frame sync
  if (asciiAt(bytes, 0, 'ID3') || isMp3FrameSync(bytes)) {
    return { kind: 'audio', mime: 'audio/mpeg' };
  }

  // WebM / Matroska
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) {
    return { kind: 'video', mime: 'video/webm' };
  }
  // MP4 / ISO-BMFF: ....ftyp
  if (bytes.length >= 8 && asciiAt(bytes, 4, 'ftyp')) {
    return { kind: 'video', mime: 'video/mp4' };
  }

  return null;
}

export function bytesToObjectUrl(bytes: Uint8Array, mime: string): string {
  const blob = new Blob([bytes], { type: mime });
  return URL.createObjectURL(blob);
}

/** 从视频 blob URL 截取一帧作为封面（JPEG blob URL） */
export function captureVideoPoster(videoUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.src = videoUrl;

    let settled = false;

    const cleanup = () => {
      video.onloadeddata = null;
      video.onseeked = null;
      video.onerror = null;
      video.removeAttribute('src');
      video.load();
    };

    const fail = (msg: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(msg));
    };

    const finish = (url: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(url);
    };

    const grabFrame = () => {
      try {
        const w = video.videoWidth;
        const h = video.videoHeight;
        if (!w || !h) {
          fail('视频无有效画面');
          return;
        }
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          fail('无法截取封面');
          return;
        }
        ctx.drawImage(video, 0, 0, w, h);
        canvas.toBlob(
          (blob) => {
            if (!blob) {
              fail('无法截取封面');
              return;
            }
            finish(URL.createObjectURL(blob));
          },
          'image/jpeg',
          0.86,
        );
      } catch (e) {
        fail(e instanceof Error ? e.message : '无法截取封面');
      }
    };

    video.onerror = () => fail('无法读取视频封面');

    video.onloadeddata = () => {
      const seekTo =
        Number.isFinite(video.duration) && video.duration > 0
          ? Math.min(0.25, video.duration * 0.05)
          : 0;
      video.onseeked = () => grabFrame();
      try {
        if (seekTo > 0.01) {
          video.currentTime = seekTo;
        } else {
          grabFrame();
        }
      } catch {
        grabFrame();
      }
    };
  });
}

export function isLikelyTextFile(file: File): boolean {
  if (file.type.startsWith('text/')) return true;
  const name = file.name.toLowerCase();
  const dot = name.lastIndexOf('.');
  if (dot < 0) return false;
  return TEXT_EXT.has(name.slice(dot));
}

export function localDateTxtName(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}.txt`;
}

export function downloadTextAsDateFile(text: string): void {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = localDateTxtName();
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function readFileAsArrayBuffer(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'));
    reader.readAsArrayBuffer(file);
  });
}

export function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'));
    reader.readAsText(file);
  });
}
