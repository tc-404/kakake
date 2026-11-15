/* ------------------------------------------------------------------ *
 *  导览运行状态
 *
 *  导览是「看」的，不是「填」的：它为了演示会主动打开连接表单、模型表单这类
 *  带输入框的弹窗，而 Radix 的 Dialog 一打开就把焦点塞给里面第一个可聚焦元素——
 *  电脑端看不出毛病，手机端会直接顶起软键盘，把说明卡片挤到屏幕外。
 *
 *  要拦住它，得让「导览是否在跑」这件事能被弹窗组件读到；反过来让导览去 import
 *  弹窗又会绕出依赖圈，所以单独放一份状态在这里，两边都只依赖它。
 * ------------------------------------------------------------------ */

type Listener = (active: boolean) => void;

let active = false;
const listeners = new Set<Listener>();

/** 导览当前是否处于运行/欢迎态（含未开始前的欢迎弹窗） */
export function isTourActive(): boolean {
  return active;
}

/**
 * 由导览组件在生命周期里调用。
 * 顺手在 <html> 上落一个 class，方便纯样式层面的兜底（也便于排查）。
 */
export function setTourActive(next: boolean): void {
  if (active === next) return;
  active = next;
  if (typeof document !== 'undefined') {
    document.documentElement.classList.toggle('kk-tour-active', next);
  }
  for (const cb of Array.from(listeners)) cb(next);
}

/** 订阅导览状态（组件需要按它临时改行为时用） */
export function subscribeTourActive(cb: Listener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/**
 * 会顶起软键盘的元素：input / textarea / select / contenteditable。
 * 只读、禁用、隐藏的一律不算——它们拿不到焦点，也不该被拦。
 */
export function isEditableElement(el: Element | null | undefined): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag !== 'INPUT') return false;
  const type = (el.getAttribute('type') || 'text').toLowerCase();
  // 按钮/开关/单选这类 input 不弹键盘
  return !['button', 'submit', 'reset', 'checkbox', 'radio', 'range', 'color', 'file'].includes(type);
}
