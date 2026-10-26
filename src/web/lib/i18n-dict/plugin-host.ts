import { registerMessages } from '@/lib/i18n';

registerMessages({
  'plugin-host.notFound': { zh: '未找到插件 {pluginId}', en: 'Plugin not found: {pluginId}' },
  'plugin-host.notLoadedAnyAccount': {
    zh: '插件尚未在任何账号上加载，请先在连接里打开子开关',
    en: 'This plugin is not loaded on any account. Enable its sub-switch in the connection first.',
  },
  'plugin-host.accountNotLoaded': {
    zh: '账号 {account} 未加载该插件',
    en: 'Account {account} has not loaded this plugin',
  },
  'plugin-host.noDefaultExport': {
    zh: '远程模块未默认导出 React 组件',
    en: 'Remote module did not default-export a React component',
  },
  'plugin-host.loading': { zh: '加载插件后台…', en: 'Loading plugin console…' },
  'plugin-host.chooseAccount': {
    zh: '该插件已在多个账号启用，请选择：',
    en: 'This plugin is enabled on multiple accounts. Please choose:',
  },
  'plugin-host.accountLabel': { zh: '账号 {a}', en: 'Account {a}' },
  'plugin-host.iframeTitle': { zh: '插件后台', en: 'Plugin Console' },
});
