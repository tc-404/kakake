import { rootLogger } from '../core/logger.js';
import { isManagedRelaunch, RELAUNCH_EXIT_CODE } from './launch-mode.js';
import { getPendingUpdate } from './update-install.service.js';

/**
 * 网页触发的「确定重启」。
 *
 * 只有受管启动器（start.bat / start.sh / 便携启动脚本 / mk 拉起的重启循环，均会设置
 * KAKAKE_MANAGED_RELAUNCH=1）才允许：进程以约定退出码 RELAUNCH_EXIT_CODE 退出，外层脚本
 * 看到该码后 →（若有 data/update-pending.json）调用 scripts/apply-update.mjs 应用暂存更新 →
 * 重新拉起框架。未受管的启动方式一律拒绝，提示用户手动重启。
 *
 * 这里只负责「优雅地结束本进程」，绝不自行替换文件——替换在进程退出后由启动器完成，
 * 从根本上规避运行中文件被占用（尤其 Windows 文件锁）的问题。
 */

let scheduled = false;

export type RestartResult = {
  ok: boolean;
  canRestart: boolean;
  willApplyUpdate: boolean;
  message: string;
};

export function requestRestart(): RestartResult {
  const canRestart = isManagedRelaunch();
  const pending = getPendingUpdate();
  const willApplyUpdate = !!pending;

  if (!canRestart) {
    return {
      ok: false,
      canRestart: false,
      willApplyUpdate,
      message: '当前启动方式不支持自动重启，请手动重启进程后生效。',
    };
  }

  if (scheduled) {
    return { ok: true, canRestart: true, willApplyUpdate, message: '重启已在进行中…' };
  }
  scheduled = true;

  rootLogger.info(
    willApplyUpdate
      ? `[update] 收到重启请求，将应用暂存更新 v${pending?.version} 后重启`
      : '[restart] 收到重启请求，进程即将退出并由启动器重新拉起',
  );

  // 延迟一小段，确保本次 HTTP 响应先回到浏览器，再退出进程
  setTimeout(() => {
    rootLogger.info(`[restart] 以退出码 ${RELAUNCH_EXIT_CODE} 退出，交由启动器处理重启/更新`);
    process.exit(RELAUNCH_EXIT_CODE);
  }, 800);

  return {
    ok: true,
    canRestart: true,
    willApplyUpdate,
    message: willApplyUpdate ? '正在应用更新并重启…' : '正在重启…',
  };
}
