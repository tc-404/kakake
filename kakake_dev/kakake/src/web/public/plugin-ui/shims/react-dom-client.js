const S = globalThis.__KAKAKE_SHARED__;
if (!S?.reactDomClient) {
  throw new Error('[kakake] shared react-dom/client missing');
}
const R = S.reactDomClient;
export default R;
export const {
  createRoot,
  hydrateRoot,
} = R;
