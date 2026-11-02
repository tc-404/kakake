import fs from 'node:fs';
import path from 'node:path';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import type { IncomingMessage } from 'node:http';
import busboy from 'busboy';

export type SavedUpload = {
  path: string;
  originalname: string;
  size: number;
  mimetype: string;
};

/** Windows 保留设备名：作为文件名落盘会在部分 API 上抛错/产生怪行为 */
const WINDOWS_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

/** 整个 multipart 请求的硬性时长上限：防慢速客户端长期占住连接与解析器 */
const MULTIPART_DEADLINE_MS = 10 * 60_000;

/**
 * 用 busboy 直接落盘，绕过 multer→type-is→media-typer 的错误依赖解析
 *（type-is@1.6 被装到 media-typer@1.1 后会把合法 multipart 判成非文件）。
 */
export function saveMultipartFile(
  req: IncomingMessage,
  fieldName: string,
  destDir: string,
  options?: { maxFileSize?: number },
): Promise<SavedUpload | null> {
  const maxFileSize = options?.maxFileSize ?? 200 * 1024 * 1024;
  fs.mkdirSync(destDir, { recursive: true });

  return new Promise((resolve, reject) => {
    let settled = false;
    let saved: SavedUpload | null = null;
    let writeError: Error | null = null;
    const pending: Promise<void>[] = [];

    const finish = (err?: Error | null, value?: SavedUpload | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (err) reject(err);
      else resolve(value ?? null);
    };

    // 到点未完成即整体放弃，不留常挂连接
    const deadline = setTimeout(() => {
      finish(new Error('上传超时'));
      req.destroy();
    }, MULTIPART_DEADLINE_MS);

    let parser: ReturnType<typeof busboy>;
    try {
      parser = busboy({
        headers: req.headers,
        limits: { fileSize: maxFileSize, files: 1, fields: 20, fieldSize: 64 * 1024 },
      });
    } catch (err) {
      finish(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    parser.on('file', (name, fileStream, info) => {
      if (name !== fieldName) {
        fileStream.resume();
        return;
      }
      if (saved) {
        fileStream.resume();
        return;
      }

      const originalname = info.filename || 'upload.bin';
      let safe = String(originalname).replace(/[^\w.\-()\u4e00-\u9fff]+/g, '_');
      if (WINDOWS_RESERVED.test(safe.replace(/\..*$/, ''))) safe = `_${safe}`;
      const outPath = path.join(destDir, `import_${Date.now()}_${safe}`);
      const out = createWriteStream(outPath);
      let size = 0;
      let limited = false;

      fileStream.on('limit', () => {
        limited = true;
      });
      fileStream.on('data', (chunk: Buffer) => {
        size += chunk.length;
      });

      const job = pipeline(fileStream, out)
        .then(() => {
          if (limited) {
            fs.unlink(outPath, () => undefined);
            writeError = new Error('文件过大');
            return;
          }
          saved = {
            path: outPath,
            originalname,
            size,
            mimetype: info.mimeType || 'application/octet-stream',
          };
        })
        .catch((err: Error) => {
          fs.unlink(outPath, () => undefined);
          writeError = err;
        });
      pending.push(job);
    });

    parser.on('error', (err: unknown) => {
      finish(err instanceof Error ? err : new Error(String(err)));
    });
    parser.on('close', () => {
      Promise.all(pending).then(() => {
        if (writeError) finish(writeError);
        else finish(null, saved);
      });
    });

    req.pipe(parser);
  });
}
