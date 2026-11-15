/**
 * WS 协议级心跳（ws 库 ping/pong 帧）共享参数，正向/反向两端共用。
 * 与 OneBot 业务层 heartbeat 事件是两层：这里探测 TCP 半开死链，不代表业务在线。
 */
export const WS_HEARTBEAT_INTERVAL_MS = 30_000;

/** 容忍 2 个周期无 pong：下一周期仍无回应即判死断开 */
export const WS_HEARTBEAT_MAX_MISSES = 2;
