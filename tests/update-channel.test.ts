import { test } from 'node:test';
import assert from 'node:assert/strict';
// 先加载存储层再拉更新服务：logger ↔ atomic-file 存在循环依赖，入口顺序会影响初始化
import '../src/storage/atomic-file.js';
import {
  compareReleaseVersions,
  detectChannel,
  resolveCurrentChannel,
  resolveUpdateTrack,
  type VersionChannel,
  type VersionInfo,
} from '../src/admin/update-check.service.js';

/**
 * 版本通道规则：
 * 1. alpha / beta / rc 属于预发布，正式版用户只跟正式版，预发布不得点亮 NEW。
 * 2. 已安装预发布版的用户继续跟预发布通道（beta.2 对 beta.1 算更新）。
 * 3. 比较必须认语义化预发布顺序：0.6.9-beta.1 < 0.6.9，
 *    而不是把 -beta.1 的 .1 当成第四段数字（旧实现因此把 beta 当成更新）。
 */

function rel(version: string, channel: VersionChannel = detectChannel(version)): VersionInfo {
  return { version, tag: version, name: version, url: '', publishedAt: '', channel };
}

test('detectChannel：识别 alpha / beta / rc，正式版不受 “source” 里的 rc 干扰', () => {
  assert.equal(detectChannel('0.6.9'), 'stable');
  assert.equal(detectChannel('v0.6.9'), 'stable');
  assert.equal(detectChannel('0.6.9-beta.1'), 'beta');
  assert.equal(detectChannel('0.7.0-rc2'), 'rc');
  assert.equal(detectChannel('0.7.0-alpha'), 'alpha');
  assert.equal(detectChannel('0.6.9-source'), 'stable');
  // GitHub 的 prerelease 标记兜底：tag 里没有通道词也按预发布处理
  assert.equal(detectChannel('0.7.0-preview.1', true), 'beta');
});

test('compareReleaseVersions：预发布顺序与数字大小', () => {
  assert.ok(compareReleaseVersions('0.6.9-beta.1', '0.6.9') < 0);
  assert.ok(compareReleaseVersions('0.7.0-alpha.1', '0.6.9') > 0);
  assert.ok(compareReleaseVersions('0.7.0-alpha.1', '0.7.0-beta.1') < 0);
  assert.ok(compareReleaseVersions('0.7.0-beta.1', '0.7.0-rc.1') < 0);
  assert.ok(compareReleaseVersions('0.7.0-rc.1', '0.7.0') < 0);
  assert.ok(compareReleaseVersions('0.7.0-beta.2', '0.7.0-beta.10') < 0);
  assert.ok(compareReleaseVersions('0.6.10', '0.6.9') > 0);
  assert.equal(compareReleaseVersions('0.7.0', '0.7.0'), 0);
  assert.equal(compareReleaseVersions('v0.7.0', '0.7.0'), 0);
});

test('正式版 0.6.9：同核心的 0.6.9-beta.1 不算更新（旧实现会误报 NEW）', () => {
  const versions = [rel('0.6.9'), rel('0.6.9-beta.1'), rel('0.6.8')];
  const track = resolveUpdateTrack('0.6.9', versions);
  assert.equal(track.hasUpdate, false);
  assert.equal(track.hasPrerelease, false);
  assert.equal(track.latestPrerelease?.version, '0.6.9-beta.1');
});

test('正式版 0.6.8：只有更高的 beta 时只做预发布提示，不算正式更新', () => {
  const versions = [rel('0.6.9-beta.1'), rel('0.6.8')];
  const track = resolveUpdateTrack('0.6.8', versions);
  assert.equal(track.hasUpdate, false);
  assert.equal(track.hasPrerelease, true);
  assert.equal(track.applicable?.version, '0.6.8');
  assert.equal(track.applicable?.channel, 'stable');
  assert.equal(track.latestPrerelease?.version, '0.6.9-beta.1');
});

test('正式版同时有 0.6.9 正式版与 0.6.9-beta.2：跟正式版', () => {
  const versions = [rel('0.6.9'), rel('0.6.9-beta.2'), rel('0.6.8')];
  const track = resolveUpdateTrack('0.6.8', versions);
  assert.equal(track.hasUpdate, true);
  assert.equal(track.applicable?.version, '0.6.9');
  assert.equal(track.applicable?.channel, 'stable');
});

test('已安装 beta：更高的 beta 算更新（继续跟预发布通道）', () => {
  const versions = [rel('0.6.9-beta.2'), rel('0.6.8')];
  const track = resolveUpdateTrack('0.6.9-beta.1', versions);
  assert.equal(track.hasUpdate, true);
  assert.equal(track.applicable?.version, '0.6.9-beta.2');
  assert.equal(track.applicable?.channel, 'beta');
});

test('已安装 beta：同核心正式版发布后优先提示正式版', () => {
  const versions = [rel('0.6.9'), rel('0.6.9-beta.2')];
  const track = resolveUpdateTrack('0.6.9-beta.1', versions);
  assert.equal(track.hasUpdate, true);
  assert.equal(track.applicable?.version, '0.6.9');
  assert.equal(track.applicable?.channel, 'stable');
});

test('当前版本号无后缀，但同核心只有预发布：归到 beta 通道', () => {
  const versions = [rel('0.6.9-beta.1'), rel('0.6.8')];
  assert.equal(resolveCurrentChannel('0.6.9', versions), 'beta');
});

test('显式通道会改变跟踪范围：稳定通道忽略 0.7.0-beta.1，beta 通道接受', () => {
  const versions = [rel('0.7.0-beta.1'), rel('0.6.8')];
  assert.equal(resolveUpdateTrack('0.6.9', versions).hasUpdate, false);
  const betaTrack = resolveUpdateTrack('0.6.9', versions, 'beta');
  assert.equal(betaTrack.hasUpdate, true);
  assert.equal(betaTrack.applicable?.channel, 'beta');
});

test('当前版本号无后缀，但同核心有正式版：不冒充预发布', () => {
  const versions = [rel('0.6.9'), rel('0.6.9-beta.1')];
  assert.equal(resolveCurrentChannel('0.6.9', versions), 'stable');
});

test('版本号自带 beta/rc 时以字符串为准', () => {
  assert.equal(resolveCurrentChannel('0.6.9-beta.2', [rel('0.6.9')]), 'beta');
  assert.equal(resolveCurrentChannel('0.6.9-rc.1', []), 'rc');
});
