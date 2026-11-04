#!/usr/bin/env node
/** 清理 packages/web/.next */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const p = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), 'packages', 'web', '.next');
if (fs.existsSync(p)) {
  fs.rmSync(p, { recursive: true, force: true });
  console.log('[clean-web-dist] removed packages/web/.next');
}
