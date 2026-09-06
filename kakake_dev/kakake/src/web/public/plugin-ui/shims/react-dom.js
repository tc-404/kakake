const S = globalThis.__KAKAKE_SHARED__;
if (!S?.reactDom) {
  throw new Error('[kakake] shared react-dom missing');
}
const R = S.reactDom;
export default R;
export const {
  createPortal,
  flushSync,
  version,
} = R;
