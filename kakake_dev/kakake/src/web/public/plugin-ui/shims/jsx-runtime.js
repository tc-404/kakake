const S = globalThis.__KAKAKE_SHARED__;
if (!S?.jsxRuntime) {
  throw new Error('[kakake] shared jsx-runtime missing');
}
const J = S.jsxRuntime;
export const jsx = J.jsx;
export const jsxs = J.jsxs;
export const Fragment = J.Fragment;
export const jsxDEV = J.jsxDEV;
