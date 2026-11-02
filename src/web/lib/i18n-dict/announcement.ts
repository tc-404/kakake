import { registerMessages } from '@/lib/i18n';

registerMessages({
  // 加载 / 进入
  'announcement.loading': { zh: '正在加载协议…', en: 'Loading agreement…' },
  'announcement.entering': { zh: '正在进入控制台…', en: 'Entering console…' },

  // 进度提示
  'announcement.readDone': { zh: '100% 阅读完毕，请点击确认', en: '100% read — tap confirm' },
  'announcement.reading': { zh: '已阅读 {progress}%', en: 'Read {progress}%' },

  // 顶部标题 / 副标题
  'announcement.title': { zh: '用户协议与公告', en: 'User Agreement & Announcement' },
  'announcement.readToBottom': { zh: '请阅读至底部后再确认', en: 'Please read to the bottom before confirming' },
  'announcement.fallbackNote': { zh: '本地备用文案', en: 'Local fallback copy' },

  // 滚动引导按钮
  'announcement.scrollDown': { zh: '向下阅读', en: 'Scroll down' },
  'announcement.jumpBottom': { zh: '跳至底部', en: 'Jump to bottom' },

  // 底部操作
  'announcement.refuse': { zh: '我拒绝', en: 'I decline' },
  'announcement.agreeTitle': { zh: '同意并进入控制台', en: 'Agree & enter console' },
  'announcement.scrollFirst': { zh: '请先滚动阅读至底部', en: 'Please scroll to the bottom first' },
  'announcement.agree': { zh: '我同意', en: 'I agree' },

  // toast 提示
  'announcement.agreed': { zh: '已同意协议', en: 'Agreement accepted' },
  'announcement.setPassword': { zh: '请设置登录密码…', en: 'Please set a login password…' },
  'announcement.refused': { zh: '已拒绝协议', en: 'Agreement declined' },
  'announcement.backToLogin': { zh: '已返回登录页', en: 'Returned to login page' },
});
