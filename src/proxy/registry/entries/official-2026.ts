/**
 * QQ 官方机器人 2026-08-10 / 2026-08-12 / 2026-10-21 三批新增能力。
 *
 * 对齐 <https://bot.qq.com/wiki/develop/api-v2/changelog.html>：
 *   - 20260810 群禁言查询、入群申请审批、入群自动审批策略、用户入群申请事件、
 *              Markdown 图片转存校验开关（force_verify_image_resource 见 official.ts）
 *   - 20260812 全局自定义菜单、指令面板管理
 *   - 20261021 素材管理（qqbot-media:// 图片引用）
 *
 * 顺带补录 20260916 修正过字段说明的「生成分享链接」。
 *
 * 这些接口都在官方 `autogen/api` 目录，本地 `_botdocs` 快照里没有；
 * `scripts/build-proxy-sources.mjs` 用 OFFICIAL_MANUAL_ADDITIONS 把它们补进源快照，
 * 否则 `npm run check:proxy` 会报 ORPHAN（注册表引用了源里没有的接口）。
 *
 * 写法约定见 `_CONVENTIONS.md`。**未在 params 里列出的键会原样透传给官方**，
 * 所以官方新增的细字段（策略规则、面板项等）可以直接按官方字段名传，代理层不改结构。
 */
import type { ProxyApiEntry } from '../../proxy.types.js';

const DOC_BASE = 'https://bot.qq.com/wiki/develop/api-v2/autogen/api/';

export const official2026Entries: ProxyApiEntry[] = [
  /* ───────────────────────── 20261021 素材管理 ───────────────────────── */
  {
    name: 'get_media_images',
    title: '查询有效素材图片',
    summary: '列出当前机器人有效的素材图片（cursor 分页，按上传时间倒序）。'
      + '单机器人上限 100 张；图片自最后一次被消息引用起 90 天未使用则失效。',
    category: 'media',
    scope: 'official-only',
    support: ['official'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['/v2/media-images'],
    params: [
      { key: 'cursor', label: '分页游标', type: 'string', sample: '', desc: '首页不传或传空串；后续传上一页返回的 next_cursor' },
    ],
    impl: {
      official: { variants: { '*': { verb: 'GET', path: '/v2/media-images' } } },
    },
    examples: {
      request: { cursor: '' },
      success: { images: [], next_cursor: '', total: 0 },
      error: { code: 40035008, message: '图片不存在或已被删除' },
    },
    docUrl: 'https://bot.qq.com/wiki/develop/api-v2/server-inter/message/material-management.html',
  },
  {
    name: 'prepare_media_image',
    title: '申请素材图片上传',
    summary: '申请图片上传，返回 upload_id 与预签名 PUT URL。'
      + '上传任务 4 小时内有效；单图不超过 10MB，支持 png / jpeg / gif / webp。'
      + '拿到 presigned_url 后需自行用 HTTP PUT 直传图片二进制，再调 complete_media_image。',
    category: 'media',
    scope: 'official-only',
    support: ['official'],
    risk: 'write',
    status: 'stable',
    alias: ['/v2/media-images/prepare'],
    params: [
      { key: 'file_name', label: '文件名', type: 'string', required: true, sample: 'kline.png', desc: '含扩展名，扩展名需与 content_type 一致' },
      { key: 'file_size', label: '文件大小（字节）', type: 'number', required: true, sample: 40156 },
      { key: 'content_type', label: '图片 MIME', type: 'string', required: true, sample: 'image/png', desc: 'image/png / image/jpeg / image/gif / image/webp' },
      { key: 'md5', label: '文件 MD5', type: 'string', required: true, sample: 'e10adc3949ba59abbe56e057f20f883e', desc: '32 位十六进制' },
      { key: 'sha1', label: '文件 SHA1', type: 'string', required: true, sample: 'd5c5d9b5b3d5d9e0a1b2c3d4e5f60718293a4b5c', desc: '40 位十六进制' },
    ],
    impl: {
      official: { variants: { '*': { verb: 'POST', path: '/v2/media-images/prepare' } } },
    },
    examples: {
      request: { file_name: 'kline.png', file_size: 40156, content_type: 'image/png', md5: 'e10adc3949ba59abbe56e057f20f883e', sha1: 'd5c5d9b5b3d5d9e0a1b2c3d4e5f60718293a4b5c' },
      success: { upload_id: 'upload_1792051409302628435_772218', presigned_url: 'https://example.cos.ap-guangzhou.myqcloud.com/robot_upload/...', expires_in: 3600 },
      error: { code: 40035007, message: '图片数量超过上限（100 张）' },
    },
    docUrl: 'https://bot.qq.com/wiki/develop/api-v2/server-inter/message/material-management.html',
  },
  {
    name: 'complete_media_image',
    title: '完成素材图片上传',
    summary: '确认图片已 PUT 到预签名 URL，返回可在 Markdown 中引用的 qqbot-media:// 链接与 image_id。'
      + '服务端会用 md5 与 COS 对象 ETag 比对，不一致返回 40035003。',
    category: 'media',
    scope: 'official-only',
    support: ['official'],
    risk: 'write',
    status: 'stable',
    alias: ['/v2/media-images/complete'],
    params: [
      { key: 'upload_id', label: '上传任务 ID', type: 'string', required: true, sample: 'upload_1792051409302628435_772218', desc: 'prepare 返回，4 小时内有效' },
      { key: 'md5', label: '上传返回的 ETag', type: 'string', required: true, sample: 'e10adc3949ba59abbe56e057f20f883e', desc: '去掉引号的 ETag（文件 MD5）' },
    ],
    impl: {
      official: { variants: { '*': { verb: 'POST', path: '/v2/media-images/complete' } } },
    },
    examples: {
      request: { upload_id: 'upload_1792051409302628435_772218', md5: 'e10adc3949ba59abbe56e057f20f883e' },
      success: { image_id: '102083127_3f9a1c4b7d2e8065', url: 'qqbot-media://image/v1/6awbXUyjS27ckbHEMVNHr_ot0jW19fq...', ttl: 7776000, preview_url: '' },
      error: { code: 40035003, message: '上传任务不存在、已过期或 MD5 不匹配' },
    },
    docUrl: 'https://bot.qq.com/wiki/develop/api-v2/server-inter/message/material-management.html',
  },
  {
    name: 'delete_media_image',
    title: '删除素材图片',
    summary: '删除指定素材图片并释放数量配额；引用链接立即失效，已发送的消息不受影响。'
      + '删除不存在的 image_id 返回 40035008。',
    category: 'media',
    scope: 'official-only',
    support: ['official'],
    risk: 'write',
    status: 'stable',
    alias: ['/v2/media-images/{image_id}/delete'],
    params: [
      { key: 'image_id', label: '图片 ID', type: 'string', idSpace: 'auto', required: true, sample: '102083127_3f9a1c4b7d2e8065' },
    ],
    impl: {
      official: { variants: { '*': { verb: 'DELETE', path: '/v2/media-images/{image_id}/delete' } } },
    },
    examples: {
      request: { image_id: '102083127_3f9a1c4b7d2e8065' },
      success: {},
      error: { code: 40035008, message: '图片不存在或已被删除' },
    },
    docUrl: 'https://bot.qq.com/wiki/develop/api-v2/server-inter/message/material-management.html',
  },

  /* ───────────────── 20260812 自定义菜单 / 指令面板 ───────────────── */
  {
    name: 'get_custom_menu',
    title: '查询全局自定义菜单',
    summary: '查询机器人全局自定义菜单。菜单仅单聊（C2C）场景生效，最多 10 项。',
    category: 'system',
    scope: 'official-only',
    support: ['official'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['/v2/menu'],
    params: [],
    impl: {
      official: { variants: { '*': { verb: 'GET', path: '/v2/menu' } } },
    },
    examples: {
      request: {},
      success: { version: 1, menu: { items: [] } },
      error: { code: 11253, message: '应用无接口访问权限' },
    },
    docUrl: `${DOC_BASE}v2_menu.get.html`,
  },
  {
    name: 'set_custom_menu',
    title: '修改全局自定义菜单',
    summary: '覆盖式修改全局自定义菜单（PUT 整体替换，不是增量）。仅单聊场景生效，最多 10 项。',
    category: 'system',
    scope: 'official-only',
    support: ['official'],
    risk: 'write',
    status: 'stable',
    alias: ['/v2/menu'],
    params: [
      { key: 'menu', label: '菜单结构', type: 'object', required: true, sample: { items: [] }, desc: '官方 menu 对象（含 items），字段名以官方文档为准，代理层原样透传' },
    ],
    impl: {
      official: { variants: { '*': { verb: 'PUT', path: '/v2/menu' } } },
    },
    examples: {
      request: { menu: { items: [] } },
      success: { version: 2 },
      error: { code: 11253, message: '应用无接口访问权限' },
    },
    docUrl: `${DOC_BASE}v2_menu.put.html`,
  },
  {
    name: 'get_panel_list',
    title: '查询指令面板列表',
    summary: '按场景查询指令面板列表，cursor 分页；默认每页 20 条、最大 50 条。scope 必填。',
    category: 'system',
    scope: 'official-only',
    support: ['official'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['/v2/panels'],
    params: [
      { key: 'scope', label: '场景', type: 'string', required: true, sample: 'c2c', desc: 'c2c=单聊 / group=群聊 / channel=文字子频道 / dm=频道私信' },
      { key: 'cursor', label: '分页游标', type: 'string', sample: '' },
      { key: 'limit', label: '每页数量', type: 'number', sample: 20, desc: '默认 20，最大 50' },
    ],
    impl: {
      official: { variants: { '*': { verb: 'GET', path: '/v2/panels' } } },
    },
    examples: {
      request: { scope: 'c2c', cursor: '', limit: 20 },
      success: { records: [], next_cursor: '', is_end: true },
      error: { code: 11253, message: '应用无接口访问权限' },
    },
    docUrl: `${DOC_BASE}v2_panels.get.html`,
  },
  {
    name: 'create_panel',
    title: '创建指令面板',
    summary: '创建指令面板，一个机器人最多 20 个面板。未列出的官方字段（target_type、user_openids、group_openids、panel.items 等）可原样传入。',
    category: 'system',
    scope: 'official-only',
    support: ['official'],
    risk: 'write',
    status: 'stable',
    alias: ['/v2/panels'],
    params: [
      { key: 'scope', label: '场景', type: 'string', required: true, sample: 'c2c', desc: 'c2c / group / channel / dm' },
      { key: 'panel', label: '面板内容', type: 'object', sample: { items: [] }, desc: '官方 panel 对象，原样透传' },
    ],
    impl: {
      official: { variants: { '*': { verb: 'POST', path: '/v2/panels' } } },
    },
    examples: {
      request: { scope: 'c2c', panel: { items: [] } },
      success: { panel_id: 'panel_102083127' },
      error: { code: 11253, message: '应用无接口访问权限' },
    },
    docUrl: `${DOC_BASE}v2_panels.post.html`,
  },
  {
    name: 'get_panel',
    title: '查询指令面板详情',
    summary: '查询指定指令面板的详情（含关联对象与面板项）。',
    category: 'system',
    scope: 'official-only',
    support: ['official'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['/v2/panels/{panel_id}'],
    params: [
      { key: 'panel_id', label: '面板 ID', type: 'string', idSpace: 'auto', required: true, sample: 'panel_102083127' },
    ],
    impl: {
      official: { variants: { '*': { verb: 'GET', path: '/v2/panels/{panel_id}' } } },
    },
    examples: {
      request: { panel_id: 'panel_102083127' },
      success: {},
      error: { code: 11253, message: '应用无接口访问权限' },
    },
    docUrl: `${DOC_BASE}v2_panels_panel_id.get.html`,
  },
  {
    name: 'update_panel',
    title: '修改指令面板',
    summary: '修改指定指令面板的内容（PUT 整体替换面板项）。',
    category: 'system',
    scope: 'official-only',
    support: ['official'],
    risk: 'write',
    status: 'stable',
    alias: ['/v2/panels/{panel_id}'],
    params: [
      { key: 'panel_id', label: '面板 ID', type: 'string', idSpace: 'auto', required: true, sample: 'panel_102083127' },
      { key: 'panel', label: '面板内容', type: 'object', required: true, sample: { items: [] }, desc: '官方 panel 对象，原样透传' },
    ],
    impl: {
      official: { variants: { '*': { verb: 'PUT', path: '/v2/panels/{panel_id}' } } },
    },
    examples: {
      request: { panel_id: 'panel_102083127', panel: { items: [] } },
      success: {},
      error: { code: 11253, message: '应用无接口访问权限' },
    },
    docUrl: `${DOC_BASE}v2_panels_panel_id.put.html`,
  },
  {
    name: 'delete_panel',
    title: '删除指令面板',
    summary: '删除指定指令面板。不可逆操作。',
    category: 'system',
    scope: 'official-only',
    support: ['official'],
    risk: 'danger',
    status: 'stable',
    alias: ['/v2/panels/{panel_id}'],
    params: [
      { key: 'panel_id', label: '面板 ID', type: 'string', idSpace: 'auto', required: true, sample: 'panel_102083127' },
    ],
    impl: {
      official: { variants: { '*': { verb: 'DELETE', path: '/v2/panels/{panel_id}' } } },
    },
    examples: {
      request: { panel_id: 'panel_102083127' },
      success: {},
      error: { code: 11253, message: '应用无接口访问权限' },
    },
    docUrl: `${DOC_BASE}v2_panels_panel_id.delete.html`,
  },
  {
    name: 'set_panel_target',
    title: '修改指令面板关联对象',
    summary: '给指定对象面板增删关联用户/群（add / del）。c2c 场景操作用户 openid，group 场景操作群 openid。',
    category: 'system',
    scope: 'official-only',
    support: ['official'],
    risk: 'write',
    status: 'stable',
    alias: ['/v2/panels/{panel_id}/target'],
    params: [
      { key: 'panel_id', label: '面板 ID', type: 'string', idSpace: 'auto', required: true, sample: 'panel_102083127' },
      { key: 'op', label: '操作', type: 'string', sample: 'add', desc: 'add=新增关联 / del=移除关联' },
    ],
    impl: {
      official: { variants: { '*': { verb: 'PUT', path: '/v2/panels/{panel_id}/target' } } },
    },
    examples: {
      request: { panel_id: 'panel_102083127', op: 'add' },
      success: {},
      error: { code: 11253, message: '应用无接口访问权限' },
    },
    docUrl: `${DOC_BASE}v2_panels_panel_id_target.put.html`,
  },

  /* ─────────── 20260810 群禁言查询 / 入群申请审批 / 自动审批策略 ─────────── */
  {
    name: 'get_group_restrict_chat',
    title: '查询群禁言状态',
    summary: '查询群的全员禁言模式与成员级禁言列表。机器人需有群管理员身份。'
      + '设置禁言仍用 set_group_ban（POST /v2/groups/{group_openid}/restrict_chat_setting）。',
    category: 'group',
    scope: 'official-only',
    support: ['official'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['/v2/groups/{group_openid}/restrict_chat_setting'],
    params: [
      { key: 'group_openid', label: '群 openid', type: 'string', idSpace: 'group_openid', required: true, sample: '9A0B0C1D2E3F4A5B6C7D8E9F0A1B2C3D' },
    ],
    impl: {
      official: { variants: { '*': { verb: 'GET', path: '/v2/groups/{group_openid}/restrict_chat_setting' } } },
    },
    examples: {
      request: { group_openid: '9A0B0C1D2E3F4A5B6C7D8E9F0A1B2C3D' },
      success: {},
      error: { code: 11253, message: '应用无接口访问权限' },
    },
    docUrl: `${DOC_BASE}v2_groups_group_openid_restrict_chat_setting.get.html`,
  },
  {
    name: 'get_join_request_list',
    title: '拉取入群申请列表',
    summary: '分页拉取待处理的入群申请（cursor / limit）。机器人需为该群管理员；'
      + '申请事件见 GROUP_JOIN_REQUEST（intent GROUP_MEMBER_EVENT = 1<<24）。',
    category: 'group',
    scope: 'official-only',
    support: ['official'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['/v2/groups/{group_openid}/join_request_list'],
    params: [
      { key: 'group_openid', label: '群 openid', type: 'string', idSpace: 'group_openid', required: true, sample: '9A0B0C1D2E3F4A5B6C7D8E9F0A1B2C3D' },
      { key: 'cursor', label: '分页游标', type: 'string', sample: '' },
      { key: 'limit', label: '每页数量', type: 'number', sample: 20 },
    ],
    impl: {
      official: { variants: { '*': { verb: 'GET', path: '/v2/groups/{group_openid}/join_request_list' } } },
    },
    examples: {
      request: { group_openid: '9A0B0C1D2E3F4A5B6C7D8E9F0A1B2C3D', cursor: '', limit: 20 },
      success: {},
      error: { code: 11253, message: '应用无接口访问权限' },
    },
    docUrl: `${DOC_BASE}v2_groups_group_openid_join_request_list.get.html`,
  },
  {
    name: 'handle_join_request',
    title: '审批入群申请',
    summary: '通过或拒绝一条入群申请。机器人需为该群管理员；拒绝时可同时把申请人加入群黑名单。',
    category: 'group',
    scope: 'official-only',
    support: ['official'],
    risk: 'write',
    status: 'stable',
    alias: ['/v2/groups/{group_openid}/approval_join_request/{member_openid}'],
    params: [
      { key: 'group_openid', label: '群 openid', type: 'string', idSpace: 'group_openid', required: true, sample: '9A0B0C1D2E3F4A5B6C7D8E9F0A1B2C3D' },
      { key: 'member_openid', label: '申请人 openid', type: 'string', idSpace: 'auto', required: true, sample: 'FE003FAF76C4817251FDC128A16753BB' },
      { key: 'op', label: '审批动作', type: 'string', required: true, sample: 'approve', desc: 'approve=通过 / decline=拒绝' },
      { key: 'join_request_id', label: '申请 ID', type: 'string', sample: 'AURi8Rr6MfGdUNedupWf2uV5XiayURHaetzwGyOdrj6mHYOsfJFkbe9u8UjCMpLTxUouwr1SJ9IGEbxlbzDi43hPS4rw64G4i2Y4nL4DTH50U15xKPZYRsXPB7WUxZOUdceNSAv_GJtO4ffSrVZIhQxknoPDSDT', desc: '取自入群申请事件或申请列表' },
      { key: 'reject_reason', label: '拒绝理由', type: 'string', sample: '不符合入群条件', desc: 'op=decline 时可填' },
      { key: 'add_to_member_blacklist', label: '同时加入群黑名单', type: 'boolean', sample: false, desc: 'op=decline 时可填，默认 false' },
    ],
    impl: {
      official: {
        variants: {
          '*': { verb: 'POST', path: '/v2/groups/{group_openid}/approval_join_request/{member_openid}' },
        },
        notes: '接口频率限制 60 QPM；响应为空对象，代理层原样透传',
      },
    },
    examples: {
      request: { group_openid: '9A0B0C1D2E3F4A5B6C7D8E9F0A1B2C3D', member_openid: 'FE003FAF76C4817251FDC128A16753BB', op: 'approve', join_request_id: 'AURi8Rr6MfGdUNedupWf2uV5XiayURHaetzwGyOdrj6mHYOsfJFkbe9u8UjCMpLTxUouwr1SJ9IGEbxlbzDi43hPS4rw64G4i2Y4nL4DTH50U15xKPZYRsXPB7WUxZOUdceNSAv_GJtO4ffSrVZIhQxknoPDSDT' },
      success: {},
      error: { code: 11253, message: '应用无接口访问权限' },
    },
    docUrl: `${DOC_BASE}v2_groups_group_openid_approval_join_request_member_openid.post.html`,
  },
  {
    name: 'get_join_approval_strategy_list',
    title: '查询入群自动审批策略',
    summary: '查询机器人已配置的入群自动审批策略列表（cursor / limit 分页）。一个机器人最多 20 个策略。',
    category: 'group',
    scope: 'official-only',
    support: ['official'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['/v2/groups/join_approval_strategy'],
    params: [
      { key: 'cursor', label: '分页游标', type: 'string', sample: '' },
      { key: 'limit', label: '每页数量', type: 'number', sample: 20 },
    ],
    impl: {
      official: { variants: { '*': { verb: 'GET', path: '/v2/groups/join_approval_strategy' } } },
    },
    examples: {
      request: { cursor: '', limit: 20 },
      success: {},
      error: { code: 11253, message: '应用无接口访问权限' },
    },
    docUrl: `${DOC_BASE}v2_groups_join_approval_strategy.get.html`,
  },
  {
    name: 'create_join_approval_strategy',
    title: '创建入群自动审批策略',
    summary: '创建入群自动审批策略（一个机器人最多 20 个）。策略规则字段按官方字段名原样透传。',
    category: 'group',
    scope: 'official-only',
    support: ['official'],
    risk: 'write',
    status: 'stable',
    alias: ['/v2/groups/join_approval_strategy'],
    params: [
      { key: 'strategy', label: '策略内容', type: 'object', sample: {}, desc: '官方策略对象（生效时间、关联群、白名单规则等），字段名以官方文档为准' },
    ],
    impl: {
      official: { variants: { '*': { verb: 'POST', path: '/v2/groups/join_approval_strategy' } } },
    },
    examples: {
      request: { strategy: {} },
      success: { strategy_id: 'strategy_102083127' },
      error: { code: 11253, message: '应用无接口访问权限' },
    },
    docUrl: `${DOC_BASE}v2_groups_join_approval_strategy.post.html`,
  },
  {
    name: 'update_join_approval_strategy',
    title: '修改入群自动审批策略',
    summary: '修改策略的生效状态、失效时间或增删关联群（PATCH）。',
    category: 'group',
    scope: 'official-only',
    support: ['official'],
    risk: 'write',
    status: 'stable',
    alias: ['/v2/groups/join_approval_strategy/{strategy_id}'],
    params: [
      { key: 'strategy_id', label: '策略 ID', type: 'string', idSpace: 'auto', required: true, sample: 'strategy_102083127' },
    ],
    impl: {
      official: { variants: { '*': { verb: 'PATCH', path: '/v2/groups/join_approval_strategy/{strategy_id}' } } },
    },
    examples: {
      request: { strategy_id: 'strategy_102083127' },
      success: {},
      error: { code: 11253, message: '应用无接口访问权限' },
    },
    docUrl: `${DOC_BASE}v2_groups_join_approval_strategy_strategy_id.patch.html`,
  },
  {
    name: 'delete_join_approval_strategy',
    title: '删除入群自动审批策略',
    summary: '删除指定入群自动审批策略。不可逆操作。',
    category: 'group',
    scope: 'official-only',
    support: ['official'],
    risk: 'danger',
    status: 'stable',
    alias: ['/v2/groups/join_approval_strategy/{strategy_id}'],
    params: [
      { key: 'strategy_id', label: '策略 ID', type: 'string', idSpace: 'auto', required: true, sample: 'strategy_102083127' },
    ],
    impl: {
      official: { variants: { '*': { verb: 'DELETE', path: '/v2/groups/join_approval_strategy/{strategy_id}' } } },
    },
    examples: {
      request: { strategy_id: 'strategy_102083127' },
      success: {},
      error: { code: 11253, message: '应用无接口访问权限' },
    },
    docUrl: `${DOC_BASE}v2_groups_join_approval_strategy_strategy_id.delete.html`,
  },
  {
    name: 'execute_join_approval_strategy',
    title: '执行入群自动审批策略',
    summary: '对策略关联的全部群发起全量扫描，命中白名单号码的入群申请自动审批通过。'
      + '异步执行，约 10 分钟完成。',
    category: 'group',
    scope: 'official-only',
    support: ['official'],
    risk: 'write',
    status: 'stable',
    alias: ['/v2/groups/join_approval_strategy/{strategy_id}/execute'],
    params: [
      { key: 'strategy_id', label: '策略 ID', type: 'string', idSpace: 'auto', required: true, sample: 'strategy_102083127' },
    ],
    impl: {
      official: { variants: { '*': { verb: 'POST', path: '/v2/groups/join_approval_strategy/{strategy_id}/execute' } } },
    },
    examples: {
      request: { strategy_id: 'strategy_102083127' },
      success: {},
      error: { code: 11253, message: '应用无接口访问权限' },
    },
    docUrl: `${DOC_BASE}v2_groups_join_approval_strategy_strategy_id_execute.post.html`,
  },
  {
    name: 'set_join_approval_whitelist',
    title: '维护入群审批白名单',
    summary: '对指定策略批量新增或删除白名单 QQ 号码（单次最多 10000 个，号码上限 10 万）。'
      + '增删动作与号码列表按官方字段名原样透传。',
    category: 'group',
    scope: 'official-only',
    support: ['official'],
    risk: 'write',
    status: 'stable',
    alias: ['/v2/groups/join_approval_strategy/{strategy_id}/whitelist_users'],
    params: [
      { key: 'strategy_id', label: '策略 ID', type: 'string', idSpace: 'auto', required: true, sample: 'strategy_102083127' },
    ],
    impl: {
      official: { variants: { '*': { verb: 'POST', path: '/v2/groups/join_approval_strategy/{strategy_id}/whitelist_users' } } },
    },
    examples: {
      request: { strategy_id: 'strategy_102083127' },
      success: {},
      error: { code: 11253, message: '应用无接口访问权限' },
    },
    docUrl: `${DOC_BASE}v2_groups_join_approval_strategy_strategy_id_whitelist_users.post.html`,
  },

  /* ───────────────── 20260916 修正字段说明的分享链接 ───────────────── */
  {
    name: 'generate_url_link',
    title: '生成机器人分享链接',
    summary: '生成用于邀请用户添加机器人为好友的分享链接；用户通过链接添加时 callback_data 会透传给开发者（最长 32 字符）。'
      + '20260916 官方修正了本接口的请求与响应字段说明。',
    category: 'system',
    scope: 'official-only',
    support: ['official'],
    risk: 'write',
    status: 'stable',
    alias: ['/v2/generate_url_link'],
    params: [
      { key: 'callback_data', label: '透传数据', type: 'string', sample: 'from=panel', desc: '最长 32 字符，用户通过链接添加机器人时回传' },
    ],
    impl: {
      official: { variants: { '*': { verb: 'POST', path: '/v2/generate_url_link' } } },
    },
    examples: {
      request: { callback_data: 'from=panel' },
      success: { url: 'https://q.qq.com/...' },
      error: { code: 11253, message: '应用无接口访问权限' },
    },
    docUrl: `${DOC_BASE}v2_generate_url_link.post.html`,
  },
];
