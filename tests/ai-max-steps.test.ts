/**
 * 单轮最大步数可配单测：data/config.json 的可选字段 aiMaxSteps → resolveMaxSteps()。
 * 缺省 60，非法值回退 60，clamp 到 [10, 200]——上限防模型死循环烧钱，下限防误配成跑不了任务。
 * 沿用 ai-tools.test.ts 的模式：写真实 config 前备份，结束后原样还原。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { configService } from '../src/core/config.service.js';
import { PATHS } from '../src/paths.js';
import { DEFAULT_MAX_STEPS, MIN_MAX_STEPS, MAX_MAX_STEPS, resolveMaxSteps } from '../src/ai/ai-agent.js';
import type { KakakeConfig } from '../src/core/types.js';

const savedConfig = configService.getConfig();
const configFileExisted = fs.existsSync(PATHS.config);

/** 探针值含非法类型（'abc' 等），类型上仍是 number|undefined，需按运行时形状写入 */
const setAiMaxSteps = (v: unknown) => {
  const cfg = { ...savedConfig, aiMaxSteps: v } as unknown as KakakeConfig;
  if (v === undefined) delete (cfg as unknown as Record<string, unknown>).aiMaxSteps;
  configService.saveConfig(cfg);
};

try {
  setAiMaxSteps(undefined);
  assert.equal(resolveMaxSteps(), DEFAULT_MAX_STEPS, '未配置 aiMaxSteps → 缺省 60');

  setAiMaxSteps(100);
  assert.equal(resolveMaxSteps(), 100, '合法配置值原样生效');

  setAiMaxSteps(5);
  assert.equal(resolveMaxSteps(), MIN_MAX_STEPS, '低于下限 → clamp 到 10');

  setAiMaxSteps(1000);
  assert.equal(resolveMaxSteps(), MAX_MAX_STEPS, '高于上限 → clamp 到 200（安全阀不可被配置解除）');

  setAiMaxSteps('abc');
  assert.equal(resolveMaxSteps(), DEFAULT_MAX_STEPS, '非数字回退缺省');

  setAiMaxSteps('80');
  assert.equal(resolveMaxSteps(), 80, '手改配置常见的字符串数字可被容错解析');

  setAiMaxSteps(55.9);
  assert.equal(resolveMaxSteps(), 55, '小数向下取整为整步数');
} finally {
  if (configFileExisted) configService.saveConfig(savedConfig);
  else fs.rmSync(PATHS.config, { force: true });
  // 重置回默认读态，避免影响后续用例
  configService.getConfig();
}

console.log('aiMaxSteps 配置解析 7 项场景全部通过');
