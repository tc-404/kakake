/**
 * 接口代理层的全部类型定义。三层自适应代理：插件只写
 * `kakake_api(短名, GET/POST, 参数)`，由 kakake 决定落到 OneBot(NapCat/SnowLuma)
 * 还是 QQ 官方机器人。
 *
 * 三条铁律（改动前必读）：
 *   1. 返回值透传：上游原样返回，元信息挂在并列的 `_proxy` 上，不污染原始字段。
 *   2. 永不空返回：一切失败都合成失败信封 resolve，绝不 reject / undefined。
 *   3. 协议不支持就是报错：野生调官方专属（或反向）按失败返回，除非显式 `force`。
 */

/* ────────────────────────────── 协议与分类 ────────────────────────────── */

/**
 * 三套目标协议。
 * 注意 napcat 与 snowluma 虽然都实现 OneBot11、在 kakake 里同属 onebot 连接，
 * 但两者的 action 集合并不相同（180 vs 200），因此必须作为两个独立标签对待。
 */
export type ProxyProtocol = 'napcat' | 'snowluma' | 'official';

export const PROXY_PROTOCOLS: ProxyProtocol[] = ['napcat', 'snowluma', 'official'];

/** 控制台徽章上展示的字面名（napcat / snowluma / q.qq.com） */
export const PROTOCOL_BADGE_LABEL: Record<ProxyProtocol, string> = {
  napcat: 'napcat',
  snowluma: 'snowluma',
  official: 'q.qq.com',
};

/** 接口分类，决定控制台左侧归类与默认的遍历顺序 */
export type ProxyCategory =
  | 'message'
  | 'media'
  | 'group'
  | 'member'
  | 'friend'
  | 'account'
  | 'system'
  | 'guild'
  | 'channel'
  | 'role'
  | 'permission'
  | 'announce'
  | 'pin'
  | 'schedule'
  | 'audio'
  | 'forum'
  | 'reaction'
  | 'interaction'
  | 'wild-only'
  | 'native';

/**
 * 接口归属。
 * - common        三协议（或其中两套）共有的能力，已合并为统一短名
 * - official-only QQ 官方独有能力（频道/子频道/身份组/日程/论坛/原生 markdown 等）
 * - wild-only     野生独有能力（点赞/表情收藏/QQ空间/打包底层等）
 * - native        逃生舱 call_native，绕过一切翻译直接发原生 action / path
 */
export type ProxyScope = 'common' | 'official-only' | 'wild-only' | 'native';

/* ────────────────────────────── 参数定义 ────────────────────────────── */

/**
 * ID 空间。
 *
 * 野生（QQ 号）与官方（openid / group_openid）之间没有官方互转通道，这是硬限制。
 * 与其假装能转换，不如把每参数期望哪种 ID 显式声明出来，由代理层在发请求前校验，
 * 不匹配就明确报错。详见 `ProxyFailure.id-space`。
 *
 * 'auto' 表示该参数的空间由另一个参数（如 scene）在运行时共同决定。
 */
export type ProxyIdSpace =
  | 'qq_number'
  | 'openid'
  | 'group_openid'
  | 'guild_id'
  | 'channel_id'
  | 'message_id'
  /** 官方身份组 ID。频道内实体，与 guild_id 不是同一个东西，不能混用 */
  | 'role_id'
  /**
   * 官方频道内的用户标识（`user_id`）。
   * 官方文档明确说明频道场景的 ID「仅在机器人场景流通，与真实 ID 无关」——
   * 它**不是 QQ 号**，也和单聊用的 openid 不是同一套。单列一项是为了避免
   * 拿 QQ 号去填频道接口这类错误被校验层放过。
   */
  | 'guild_user_id'
  | 'auto';

export interface ProxyParamSpec {
  /** 统一键名，snake_case。插件与外放 URL 上都用这个名字 */
  key: string;
  /** 中文展示名，仅用于控制台 */
  label: string;
  type: 'string' | 'number' | 'boolean' | 'object' | 'array' | 'file';
  required?: boolean;
  /** 说明（进详情页） */
  desc?: string;
  idSpace?: ProxyIdSpace;
  /** 仅部分协议下有意义的参数 */
  only?: ProxyProtocol[];
  /** 示例值，用于生成请求示例与详情页 placeholder */
  sample?: unknown;
}

/* ────────────────────────────── 协议实现映射 ────────────────────────────── */

/**
 * 某协议下的一次落点。
 *
 * 一条统一短名在不同协议下（甚至同一协议的不同场景）会落到不同的原生接口，
 * 靠 `ProxyImpl.variantBy` + `variants` 表达。例：send_text 在本的 scene 取值
 * group / private / channel / dms 时分别对应四个不同的原生 action 或 path。
 */
export interface ProxyVariant {
  /** OneBot 系：action 名 */
  action?: string;
  /** OneBot 系 HTTP 方法；不填表示沿用调用方传入的 GET/POST */
  obMethod?: 'GET' | 'POST';

  /** QQ 官方：path 模板，路径参数用 {xxx} 占位 */
  path?: string;
  /** QQ 官方：HTTP 动词。官方不支持「任意方法」，必填 */
  verb?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

  /** 统一键 → 协议实际键。未列出的键原样透传 */
  map?: Record<string, string>;
  /** 常量注入：协议端必带、但统一参数里不该出现的字段（如官方的 msg_type） */
  const?: Record<string, unknown>;
  /** 具名值转换器，引用 translate/transforms.ts 的键 */
  transforms?: Record<string, string>;
  /** 需要丢弃的键，防止原样透传把 scene 这类派发字段也发给协议端 */
  drop?: string[];

  /**
   * 前置步骤：先发一个请求，把结果注入主请求后再发主请求。
   *
   * QQ 官方发图片/语音/视频必须先调文件上传接口拿到 `file_info`（或 `media`），
   * 再把它塞进发消息请求体 —— 单次请求做不到。OneBot 侧是消息段内联 base64/url，
   * 不需要这一步，所以 pre 只在官方变体上出现。
   *
   * 前置步骤失败时整条调用按失败信封返回，`_proxy.failure` 为 'upstream'，
   * 并且 `native` 记的是前置的 path（真正失败的那一步），便于排查。
   */
  pre?: {
    /** OneBot 系：前置 action 名 */
    action?: string;
    /** QQ 官方：前置 path 模板 */
    path?: string;
    verb?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    /** 主参数 → 前置请求参数的键名映射；未列入的同名键自动带上 */
    from?: Record<string, string>;
    /**
     * 前置请求参数白名单。只把列出的统一键带进前置请求体（配合 transforms
     * 拆分 url / file_data / file_type 用）。不填 = 同名全带（旧行为）。
     */
    only?: string[];
    /**
     * 该统一键缺失时整个前置步骤跳过。用于「同一条接口既发纯文本又发媒体」的
     * 统一条目：纯文本没有 file 可上传，前置上传必须让路，否则文本也发不出去。
     */
    skipWhenMissing?: string;
    /** 前置请求体里要丢弃的键（典型：已被 transforms 消费掉的原始 file） */
    drop?: string[];
    /**
     * 前置请求体的具名值转换器，键为前置请求体的目标键。
     * 转换器入参 `params` 是调用方的完整统一参数（不是前置请求体），
     * 便于从 `params.file` / `params.media_type` 推导 url / file_data / file_type。
     */
    transforms?: Record<string, string>;
    /** 前置请求需要的常量（如 `srv_send_msg: false`） */
    const?: Record<string, unknown>;
    /** 把前置响应注入主请求的哪个键下 */
    injectAs: string;
    /**
     * 从前置响应里取哪一段。`'data'` 取 OneBot 的 data / 官方的响应体本身；
     * 支持点路径如 `'data.file_info'`。不填即整个响应体。
     */
    pick?: string;
  };

  /** 协议端自己标注为「未实现 / 占位」，调用会失败但要有据可查 */
  stub?: boolean;
  /** 备注，进详情页「协议实现对照」表 */
  notes?: string;
}

export interface ProxyImpl {
  /** 依据哪个统一参数选变体；不填则只用 '*' 这一个变体 */
  variantBy?: string;
  variants: Record<string, ProxyVariant>;
  /** 该协议整体未提供此能力 */
  stub?: boolean;
  /** 前置条件，如「原生 markdown 需内邀开通」 */
  requires?: string;
  /**
   * 协议端与 variants 等价的其它注册名。
   *
   * 存在的原因：NapCat / SnowLuma 常把同一份 handler 注册成两个 action 名
   * （如 `set_group_sign` 与 `send_group_sign`、`upload_forward_msg` 与拼写错误的
   * `upload_foward_msg`）。它们在功能上完全是同一个接口，按「功能相同的合并为一个
   * 代理接口」的要求不该占两条 entry，但覆盖率对账必须能认出这些名字已被覆盖。
   *
   * 这里只是**声明别名**，运行时一律走 `variants` 里的 action，不会拿 sameAs 去发请求；
   * 控制台接口详情页会把它们列成「协议端别名」，方便插件作者按旧名搜索。
   */
  sameAs?: string[];
  /**
   * 这一层也需要 notes：有些说明是**整个协议**层面的（例如「OneBot 的 delete_msg
   * 不区分场景，scene 会被丢弃」「官方此接口同时承载两种语义」），挂在某个变体上
   * 并不合适。详情页的「协议实现对照」表会优先展示这一层。
   */
  notes?: string;
}

/* ────────────────────────────── 示例 ────────────────────────────── */

export interface ProxyExamples {
  request: Record<string, unknown>;
  /** 成功响应的原文（透传形态，不含 _proxy） */
  success: unknown;
  /** 失败响应的原文 */
  error: unknown;
  /** 各协议信封不同时，按协议覆盖 */
  byProtocol?: Partial<Record<ProxyProtocol, {
    request?: Record<string, unknown>;
    success?: unknown;
    error?: unknown;
  }>>;
}

/* ────────────────────────────── 注册表条目 ────────────────────────────── */

export interface ProxyApiEntry {
  /** 短名：既是 kakake_api 第一参，也是外放 URL 的最后一段。/^[a-z][a-z0-9_]{1,39}$/ */
  name: string;
  /** 中文展示名 */
  title: string;
  /** 一句话功能说明 */
  summary: string;
  category: ProxyCategory;
  /** 搜索别名：把全部原生 action / path 都塞进来，保证老接口名还能搜到 */
  alias?: string[];
  /** 支持的协议，决定控制台徽章与是否降级为报错 */
  support: ProxyProtocol[];
  scope: ProxyScope;
  params: ProxyParamSpec[];
  impl: Partial<Record<ProxyProtocol, ProxyImpl>>;
  examples: ProxyExamples;
  /** 只读接口：只影响 UI 提示，不强制限制方法 */
  readOnly?: boolean;
  /** 危险等级，danger 的在控制台标红 */
  risk?: 'read' | 'write' | 'danger';
  status?: 'stable' | 'experimental' | 'stub';
  /** 官方文档锚点 */
  docUrl?: string;
  /**
   * 整条接口的备注，进详情页顶部。
   * 与 `ProxyImpl.notes` / `ProxyVariant.notes` 是三级：
   * 条目级（这条接口整体）→ 协议级（某协议下）→ 变体级（某场景变体）。
   */
  notes?: string;
}

/** 控制台列表用：不含 examples 的摘要，避免 catalog 接口过大 */
export type ProxyApiSummary = Omit<ProxyApiEntry, 'examples'>;

/* ────────────────────────────── 失败与元信息 ────────────────────────────── */

/**
 * 失败分类。
 * - upstream        协议端正常回了失败信封（这是「透传」，不是代理的锅）
 * - timeout         超过 apiTimeoutMs 未响应
 * - network         连接层出错（断连、DNS、非预期异常）
 * - unsupported     当前分发协议不支持此接口 / 此变体
 * - intercepted     被 before 钩子返回 false 拦截，压根没发出去
 * - id-space        QQ 号与 openid 空间不匹配
 * - missing-param   必填或路径参数缺失
 * - unknown-api     注册表里没有这个短名
 * - not-connected   连不上（未连接 / 连接被禁用 / 是 KOOK 或微信连接）
 */
export type ProxyFailure =
  | 'upstream'
  | 'timeout'
  | 'network'
  | 'unsupported'
  | 'intercepted'
  | 'id-space'
  | 'missing-param'
  | 'unknown-api'
  | 'not-connected';

/** 代理层合成失败信封用的私有 retcode（与协议自身的 retcode 错开） */
export const PROXY_RETCODE = {
  /** 协议不支持 */
  unsupported: -1001,
  /** 超时 */
  timeout: -1002,
  /** ID 空间不匹配 */
  idSpace: -1003,
  /** 参数缺失 */
  missingParam: -1004,
  /** 未知接口 */
  unknownApi: -1005,
  /** 未连接 */
  notConnected: -1006,
  /** 网络层异常 */
  network: -1007,
  /** 被 before 钩子拦截 */
  intercepted: -1008,
} as const;

/**
 * 挂在返回值 `_proxy` 字段上的元信息。
 * 刻意用 `_proxy` 这个不太可能与上游冲突的名字；万一真撞了，由 runtime/meta.ts
 * 自动改挂 `__kakake_proxy` 并在 failure 里留痕。
 */
export interface ProxyMeta {
  api: string;
  protocol: ProxyProtocol;
  /** 命中的变体键；单变体时为 '*' */
  variant: string;
  connectionId: string;
  /** OneBot 连接背后的协议端实现；仅 onebot 连接才有意义 */
  onebotImpl?: string;
  /** 实际发出的原生 action 名或 path */
  native: string;
  httpMethod: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'WS';
  elapsedMs: number;
  at: number;
  timeoutMs: number;
  /** 上游 HTTP 状态码；官方侧必有，OneBot HTTP 通道也有 */
  httpStatus?: number;
  /** 降级原因 */
  degraded?: 'unsupported' | 'intercepted' | 'id-space' | 'stub';
  /** 调用方传 GET 但协议端只接受 POST 时被改写 */
  methodAdjusted?: boolean;
  /** 原始响应不是对象时的兜底形态标记 */
  rawKind?: 'object' | 'array' | 'primitive' | 'null';
  /** 失败分类；成功时为 undefined */
  failure?: ProxyFailure;
  /** 钩子作用域 ID，便于定位是哪个插件注册的钩子 */
  source?: string;
}

export type ProxyResponse<T = unknown> = T & { _proxy: ProxyMeta };

/**
 * 所有路径都返回一个「OneBot 形态」的信封，即便是官方请求。
 * 这样插件侧 `res.status === 'ok'` 的判断在任何协议下都成立。
 */
export interface ProxyEnvelope<T = unknown> {
  status: 'ok' | 'failed';
  retcode: number;
  data: T;
  message: string;
  wording?: string;
  echo?: unknown;
}

export type ProxyResult<T = unknown> = ProxyEnvelope<T> & { _proxy: ProxyMeta };

/* ────────────────────────────── 调用选项 ────────────────────────────── */

export interface ProxyCallOptions {
  /**
   * 指定连接：connectionId / 机器人 QQ 号 / 官方 appId 均可。
   * 不传时依次回退：事件当前连接 → 插件绑定连接 → 默认活跃连接。
   */
  conn?: string;
  /** 覆盖全局 apiTimeoutMs，钳制在 5s~600s */
  timeoutMs?: number;
  /**
   * 改为抛异常（对齐旧版 `ctx.actions.call` 的写法）。
   * 默认是 resolve 失败信封。
   */
  throwOnError?: boolean;
  /**
   * 忽略「协议不支持」降级，强行发出请求。
   * 用于探索性调用；即便如此 `_proxy.degraded` 依然会标记。
   */
  force?: boolean;
}

export type ProxyHttpMethod = 'GET' | 'POST';

/* ────────────────────────────── 钩子 ────────────────────────────── */

export interface ProxyHookCtx {
  protocol: ProxyProtocol;
  connectionId: string;
  /** after / error 钩子才有 */
  meta?: ProxyMeta;
  /** 调用来源，便于区分是哪个插件的钩子 */
  source: { pluginId?: string; accountKey?: string; adapter?: string };
}

/** 返回 false 表示拦截（不发请求）；返回对象表示改写参数；返回 undefined 表示放行 */
export type ProxyBeforeHook = (
  api: string,
  params: Record<string, unknown>,
  ctx: ProxyHookCtx,
) => void | false | Record<string, unknown> | Promise<void | false | Record<string, unknown>>;

export type ProxyAfterHook = (
  api: string,
  params: Record<string, unknown>,
  result: unknown,
  ctx: ProxyHookCtx,
) => void | Promise<void>;

export type ProxyErrorHook = (
  api: string,
  params: Record<string, unknown>,
  err: { failure: ProxyFailure; message: string; meta: ProxyMeta },
  ctx: ProxyHookCtx,
) => void | Promise<void>;

/** 注册钩子统一返回注销函数 */
export type HookUnregister = () => void;

/* ────────────────────────────── 插件侧门面 ────────────────────────────── */

export interface KakakeApi {
  (
    name: string,
    method?: ProxyHttpMethod,
    params?: Record<string, unknown>,
    opts?: ProxyCallOptions,
  ): Promise<ProxyResult>;

  /** 三钩子注册，均返回注销函数；作用域随插件生命周期自动释放 */
  before(hook: ProxyBeforeHook): HookUnregister;
  after(hook: ProxyAfterHook): HookUnregister;
  error(hook: ProxyErrorHook): HookUnregister;
  /** 另一种写法：kakake_api.on.before(fn) */
  readonly on: {
    before(hook: ProxyBeforeHook): HookUnregister;
    after(hook: ProxyAfterHook): HookUnregister;
    error(hook: ProxyErrorHook): HookUnregister;
  };

  /** 查注册表，插件自检用 */
  list(filter?: { protocol?: ProxyProtocol; category?: ProxyCategory }): ProxyApiSummary[];
  get(name: string): ProxyApiEntry | undefined;

  /** 当前实例默认绑定的连接；事件上下文里 binding.connectionId 已被重写 */
  readonly binding: { connectionId?: string; protocol?: ProxyProtocol };

  /**
   * 逃生舱：直连原生接口，跳过变体选择与参数翻译。
   * 官方连接传 path（如 `/v2/groups/{group_openid}/messages`），OneBot 连接传 action 名。
   * 返回值与 kakake_api(...) 完全同构，同样带 _proxy 元信息。
   */
  native(
    target: string,
    params?: Record<string, unknown>,
    opts?: ProxyCallOptions,
  ): Promise<ProxyResult>;
}
