/**
 * 寻址层的 kakake 适配：把 ConnectionManager / configService 接进
 * `createProxyTargetResolver` 的最小端口上。
 *
 * 这一层是唯一允许 import kakake 运行时模块的地方——上面的 target.ts 只认端口，
 * 所以寻址规则本身可以脱离 kakake 单测。
 */
import type { ConnectionManager } from '../../connection/connection.manager.js';
import { configService } from '../../core/config.service.js';
import { detectOnebotImpl, type OnebotImplSetting } from './impl-detect.js';
import { createProxyTargetResolver, type ProxyConnectionView } from './target.js';

function isConnected(view: { id: string; type?: string }, manager: ConnectionManager): boolean {
  if (view.type === 'qq_official') {
    return manager.getQqOfficialClient(view.id)?.isConnected === true;
  }
  if (view.type === 'weixin_bot' || view.type === 'kook') {
    // 这两类不在接口代理的三套协议范围内，恒视为未连接，
    // 于是默认连接兜底会跳过它们，而不是选到一个发不出请求的连接
    return false;
  }
  return manager.getOnebotEndpoint(view.id)?.isConnected === true;
}

export function createKakakeTargetResolver(manager: ConnectionManager) {
  return createProxyTargetResolver({
    listConnections(): ProxyConnectionView[] {
      return configService.getConnections().connections.map((c) => ({
        id: c.id,
        name: c.name,
        type: c.type,
        enable: c.enable,
        onebotImpl: c.onebotImpl as OnebotImplSetting | undefined,
        isConnected: isConnected(c, manager),
      }));
    },

    async detectOnebotImpl(connectionId: string) {
      const conn = configService.getConnection(connectionId);
      const ep = conn ? manager.getOnebotEndpoint(conn.id) : undefined;
      if (!conn || !ep) return 'unknown';
      return detectOnebotImpl(conn.onebotImpl, connectionId, async () => {
        if (!ep.callActionRaw) {
          return { ok: false, error: '该连接未提供 callActionRaw 通道，无法探测协议端实现' };
        }
        return ep.callActionRaw('get_version_info');
      });
    },
  });
}
