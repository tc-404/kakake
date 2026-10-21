/**
 * 统一触发各业务字典注册。
 *
 * 由 main.tsx 在首帧渲染前 `import '@/lib/i18n-dict/register';` 引入，
 * 确保 registerMessages() 在所有 t() 调用之前执行完毕。
 *
 * 注意：这里只 import 各字典模块的「副作用」（模块顶层会调用 registerMessages），
 * 不要从这里反向 import i18n 的 t/useT，否则会重新形成 i18n ↔ 字典模块的循环依赖。
 */
import '@/lib/i18n-dict/common';
import '@/lib/i18n-dict/layout';
import '@/lib/i18n-dict/settings';
import '@/lib/i18n-dict/dashboard';
import '@/lib/i18n-dict/connections';
import '@/lib/i18n-dict/plugins';
import '@/lib/i18n-dict/plugin-host';
import '@/lib/i18n-dict/plugin-store';
import '@/lib/i18n-dict/tools';
import '@/lib/i18n-dict/open-platform';
import '@/lib/i18n-dict/ai';
import '@/lib/i18n-dict/simulate';
import '@/lib/i18n-dict/logs';
import '@/lib/i18n-dict/announcement';
import '@/lib/i18n-dict/login';
import '@/lib/i18n-dict/components';
import '@/lib/i18n-dict/update';
import '@/lib/i18n-dict/tour';
