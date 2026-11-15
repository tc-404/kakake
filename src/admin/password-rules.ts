/** 自定义登录密码强度规则（与前端 checklist 一致） */

const HAS_DIGIT = /\d/;
const HAS_UPPER = /[A-Z]/
const HAS_LOWER = /[a-z]/
const HAS_PUNCT = /[!-/:-@[-`{-~]/
const HAS_CHINESE = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/;

/** 长度须超过此值（即至少 11 位） */
export const PASSWORD_MIN_LEN = 10;
export const PASSWORD_MAX_LEN = 64;

export function validateCustomPassword(password: string): string | null {
  if (password.length > PASSWORD_MAX_LEN) return `密码不能超过 ${PASSWORD_MAX_LEN} 位`;
  if (password.length <= PASSWORD_MIN_LEN) return '长度超过10个字符';
  if (HAS_CHINESE.test(password)) return '不得有中文';
  if (!HAS_DIGIT.test(password)) return '必须有数字';
  if (!HAS_UPPER.test(password)) return '必须有大写字母';
  if (!HAS_LOWER.test(password)) return '必须有小写字母';
  if (!HAS_PUNCT.test(password)) return '必须包含特殊符号';
  return null;
}
