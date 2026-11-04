/** 自定义登录密码规则（前后端保持一致） */

export type PasswordRuleId =
  | 'digit'
  | 'upper'
  | 'lower'
  | 'punct'
  | 'length'
  | 'noChinese';

export type PasswordRule = {
  id: PasswordRuleId;
  label: string;
  /** 已满足 */
  ok: boolean;
  /** 明确违规（如含中文），列表标红 */
  fail?: boolean;
};

const HAS_DIGIT = /\d/;
const HAS_UPPER = /[A-Z]/
const HAS_LOWER = /[a-z]/
/** ASCII 标点 / 特殊符号 */
const HAS_PUNCT = /[!-/:-@[-`{-~]/
/** 中日韩统一表意文字等常见中文区间 */
const HAS_CHINESE = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/;

/** 长度须超过此值（即至少 11 位） */
export const PASSWORD_MIN_LEN = 10;
export const PASSWORD_MAX_LEN = 64;

export function hasChineseInPassword(password: string): boolean {
  return HAS_CHINESE.test(password);
}

export function evaluatePasswordRules(password: string): PasswordRule[] {
  const pwd = password;
  const typed = pwd.length > 0;
  const hasCn = HAS_CHINESE.test(pwd);

  return [
    { id: 'digit', label: '必须有数字', ok: HAS_DIGIT.test(pwd) },
    { id: 'upper', label: '必须有大写字母', ok: HAS_UPPER.test(pwd) },
    { id: 'lower', label: '必须有小写字母', ok: HAS_LOWER.test(pwd) },
    { id: 'punct', label: '必须包含特殊符号', ok: HAS_PUNCT.test(pwd) },
    { id: 'length', label: '长度超过10个字符', ok: pwd.length > PASSWORD_MIN_LEN },
    {
      id: 'noChinese',
      label: '不得有中文',
      ok: typed && !hasCn,
      fail: hasCn,
    },
  ];
}

export function isPasswordFullyValid(password: string): boolean {
  return evaluatePasswordRules(password).every((r) => r.ok) && password.length <= PASSWORD_MAX_LEN;
}

export function passwordValidationMessage(password: string): string | null {
  if (password.length > PASSWORD_MAX_LEN) return `密码不能超过 ${PASSWORD_MAX_LEN} 位`;
  const failed = evaluatePasswordRules(password).filter((r) => !r.ok);
  if (failed.length === 0) return null;
  return `密码未满足：${failed.map((r) => r.label).join('、')}`;
}
