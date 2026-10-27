# 接口代理注册表 · 写作约定

**改任何 entry 前先读完这份文件。** 这是 445 个原生接口收敛成统一短名的唯一规范。
违反约定会让 250+ 条数据风格漂移，后期无法审校。

---

## 0. 一句话目标

插件只写 `await kakake_api('send_msg', 'POST', { scene:'group', group_id:123, message:'你好' })`，
由 kakake 决定这次落到 NapCat、SnowLuma 还是 QQ 官方。

> 历史说明：`send_text` / `send_image` 已并入统一发消息条目 `send_msg`（发消息），
> 旧短名保留为别名继续可用。发送内容（文本 / 图片 / 语音 / 视频 / 混发）由
> `message` / `file` 参数的 JSON 形态决定，不再按消息类型拆条目。

---

## 1. 短名（name）

- 正则 `^[a-z][a-z0-9_]{1,39}$`，**全小写 snake_case**
- 动词在前、宾语在后：`send_text` / `recall_msg` / `set_group_ban` / `get_login_info`
- **不要**把协议名写进短名（错误示范：`send_official_markdown` 应为 `send_markdown`）
- **不要**把场景写进短名（错误示范：`send_group_msg` 应为 `send_text` + `scene:'group'`）
- 同名能力三协议合并成一条；协议专属能力才单独开名（如 `send_markdown`）

### 动词表（照此选，不要自创）

| 动词 | 用途 | 例 |
|---|---|---|
| `send_` | 发出消息/内容 | `send_text` `send_image` `send_markdown` |
| `get_` | 查询读取 | `get_login_info` `get_group_list` |
| `set_` | 设置为某值 | `set_group_name` `set_group_ban` |
| `create_` / `delete_` | 增 / 删 | `create_channel` `delete_channel` |
| `update_` / `patch_` | 改（官方 PATCH 语义用 patch） | `update_channel` |
| `recall_` | 撤回 | `recall_msg` |
| `upload_` / `download_` | 上传 / 下载 | `upload_file` `download_file` |
| `add_` / `remove_` | 加入 / 移除 | `add_role_member` `remove_role_member` |
| `mute_` / `unmute_` | 禁言 / 解禁 | `mute_member` |
| `handle_` | 处理请求/事件 | `handle_friend_request` |
| `mark_` / `unmark_` | 标记 / 取消 | `mark_pin` |
| `call_` | 逃生舱 | `call_native` |

---

## 2. 场景派发（scene）—— 最重要的机制

**三套协议的「群」和「私聊」语义相同但 ID 空间不同，所以按 `scene` 派发，不按 ID 名字派发。**

`scene` 取值只有四个：

| scene | 语义 | 野生（napcat/snowluma） | 官方（official） |
|---|---|---|---|
| `group` | 群聊 | `group_id`（QQ 群号） | `group_openid` |
| `private` | 私聊 | `user_id`（QQ 号） | `openid` |
| `channel` | 官方子频道 | ✗ 不支持 | `channel_id` |
| `dms` | 官方频道私信 | ✗ 不支持 | `guild_id` |

**关键**：`scene:'group'` 在 napcat 变体里用 `group_id`，在 official 变体里用 `group_openid`——
写 entry 时两者都要声明为参数并用 `only` 限定协议，但**派发只看 scene，不看传了哪个 ID**。
连接本身是野生还是官方，由 kakake 在运行时决定（这是需求原文「由 kakake 在调用时决定实际分发到哪个协议」）。

`variantBy` 指定的字段（即 `scene`）**由 dispatcher 自动丢弃**，不会发给协议端，
所以 variants 里**不要**写 `drop: ['scene']`。`drop` 只用于额外要剔除的键。

野生侧没有 `channel` / `dms` 变体 → 分发时找不到变体 → 自动降级为 `unsupported` 失败信封。正确行为，不要为了「对齐」编造野生变体。

---

## 3. 参数（params）

### 统一键名（照此选，不要自创同义键）

| 统一键 | 含义 | idSpace | 适用协议 |
|---|---|---|---|
| `scene` | 场景 | — | 全部 |
| `group_id` | QQ 群号（数字） | `qq_number` | 野生 |
| `user_id` | QQ 号（数字） | `qq_number` | 野生 |
| `group_openid` | 官方群 openid（字符串） | `group_openid` | 官方 |
| `openid` | 官方用户 openid | `openid` | 官方 |
| `guild_id` | 官方频道 ID | `guild_id` | 官方 |
| `channel_id` | 官方子频道 ID | `channel_id` | 官方 |
| `message` | 消息内容（string 或 OneBot segment 数组） | — | 全部 |
| `message_id` | 消息 ID | `message_id` | 全部 |
| `content` | 纯文本内容（与 message 二选一的条目才用） | — | — |
| `reason` | 操作理由（踢人/拒绝请求） | — | 全部 |
| `duration` | 时长，单位**秒**（禁言/临时文件） | — | 全部 |
| `count` / `limit` / `offset` | 分页 | — | 全部 |
| `file` | 本地绝对路径或 URL | — | 全部 |
| `enable` | 布尔开关 | — | 全部 |

**优先复用 `message` 而不是 `content`**：OneBot 有 2 套、官方只有 1 套，少数服从多数；
且 `message` 能容纳 segment 数组，官方侧 `map` 到 `content` 即可。

### 字段填写

- `key` 必填；`label` 中文展示名必填；`type` 必填
- 必填参数加 `required: true`
- 涉及 ID 的**必须**写 `idSpace`，否则代理层无法做空间校验
- 只在一部分协议下有效的参数加 `only: ['napcat','snowluma']` 或 `only: ['official']`
- 每个参数尽量给 `sample`（详情页要展示请求示例，没有 sample 的示例很难看）

---

## 4. 协议实现（impl）

```ts
impl: {
  napcat: {
    variantBy: 'scene',            // 可选；不写则只有 '*' 一个变体
    variants: {
      group:   { action: 'send_group_msg' },
      private: { action: 'send_private_msg' },
    },
  },
  snowluma: { /* 同上 */ },
  official: {
    variantBy: 'scene',
    variants: {
      group: { verb: 'POST', path: '/v2/groups/{group_openid}/messages',
               map: { message: 'content' }, const: { msg_type: 0 } },
    },
  },
}
```

### 规则

- **OneBot 系（napcat / snowluma）**：只写 `action`，不写 `verb`。
  `obMethod` 仅在协议端强制要求某方法时才写（极少数，多半不写）。
- **官方**：`verb` 与 `path` **必须成对出现**，缺一不可（门禁靠这对做覆盖率对账）。
  路径参数用 `{xxx}` 占位，占位名必须能在 params 里找到同名键。
- `map`：统一键 → 协议实际键。**未列出的键原样透传**，所以只写真正要改名的。
- `const`：协议端必带但统一参数里不该出现的常量（如官方 `msg_type: 0`）。
- `transforms`：需要值转换时引用 `translate/transforms.ts` 的键名。
- `stub: true`：协议端源码/文档标注「未实现 / 占位」的，标上并在 `notes` 写明依据。
- 整条协议没有这个能力：impl 里**不出现**该协议的键（而不是写 `{ stub: true }` 空壳）——
  这样 `support` 数组就足以表达，UI 也干净。

### support 与 impl 的一致性

`support` 里列的协议，`impl` 里必须有对应块；反之亦然。**两者不一致是硬错误。**

---

## 5. 示例（examples）—— 不许编造

- `request`：野生视角的统一参数示例（默认展示给用户的那份）
- `success` / `error`：**野生信封**形态
  - 成功：`{ status:'ok', retcode:0, data:{...}, message:'', wording:'', echo:null }`
  - 失败：`{ status:'failed', retcode:1200, data:null, message:'...', wording:'...', echo:null }`
- `byProtocol.official`：官方响应**不是信封**——成功直接返回业务对象（如 `{ id:'...', content:'...' }`），
  失败返回 `{ code: 11252, message:'...' }` 且 HTTP 非 2xx。必须分开写。

**拿不准真实返回结构时**：写协议端的语义但**不要编字段名**。
`data` 结构无法静态确定的（NapCat 里 `returnSchema` 是 `Type.Any()` 的那批），
`data` 写 `null` 并在 `notes` 标注「返回结构未文档化」。

---

## 6. 元字段

- `category`：从 `ProxyCategory` 里选，决定控制台归类
- `scope`：`common` / `official-only` / `wild-only` / `native`
- `risk`：`read`（查询）/ `write`（写操作）/ `danger`（踢人、解散、全员禁言、设管理员等不可逆）
- `status`：`stable` / `experimental` / `stub`
- `alias`：**把全部原生 action 名和官方 path 都塞进来**，保证老代码里的接口名还能搜到。
  例：`send_text` 的 alias 应含 `send_group_msg`、`send_private_msg`、`send_msg`、
  `/v2/users/{openid}/messages` 等。
- `docUrl`：官方文档锚点，有就填

---

## 7. 文件组织

按 category 分文件，每个文件导出一个 `ProxyApiEntry[]`：

```
entries/
  message.ts   消息收发（send_* / recall_* / get_msg）
  media.ts     富媒体（图片/语音/视频/文件上传下载）
  group.ts     群管理（群设置/群公告/群精华/群文件）
  member.ts    群成员（踢人/禁言/改名片/设管理员）
  friend.ts    好友（好友列表/请求处理/点赞/戳一戳）
  account.ts   账号资料（登录信息/资料修改/表情收藏）
  system.ts    系统（版本/状态/缓存/ Cookies）
  guild.ts     频道、子频道、身份组、权限、禁言（官方专属）
  official.ts  日程/音频/论坛/精华/公告/表态/交互（官方专属）
  wild.ts      野生专属（QQ空间/系统表情/底层发包/流式传输）
  native.ts    逃生舱 call_native
```

**文件头必须 `import type { ProxyApiEntry } from '../../proxy.types';`**

---

## 8. 三条铁律（违反即打回）

1. **透传**：`map` 只改键名，`const` 只加常量——**不许**重新构造上游响应结构。
2. **永不空返回**：协议不支持就写在 `support` 里缺席（或标 `stub`），让 dispatcher 合成失败信封。
   不要为了让调用「看起来成功」而编一个假返回。
3. **不许编造**：不确定就标 `stub` / `notes` 说明，或 `data: null`。
   宁可信息少，不可信息假——假的字段会让插件作者按错误的契约写一辈子代码。

---

## 9. 自检清单（写完自查）

- [ ] 短名符合正则、动词来自动词表
- [ ] `support` 与 `impl` 的协议键完全一致
- [ ] 官方变体 `verb` + `path` 成对；path 占位能在 params 找到
- [ ] 涉及 ID 的参数都写了 `idSpace`
- [ ] 野生侧没有编造 `channel` / `dms` 变体
- [ ] `alias` 收全了所有原生名
- [ ] `risk` 标对了（踢人/全员禁言/解散是 `danger`）
- [ ] examples 没编造未知字段
