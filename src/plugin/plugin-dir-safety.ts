/**
 * 插件目录名禁止项：路径分隔符、上跳段、盘符、控制字符。
 * 包内 package.json 声明的 name 一律不得借目录名逃出插件根——
 * kakake-/GF-/ss-plugin-/WX-/sssx-plugin- 五套归一化在透传原样输入前都必须过这道闸。
 */
export function assertSafePluginDirName(name: string): void {
  if (/[\\/]|\.\.|:|[\0-\x1f]/.test(name)) {
    throw new Error(
      `插件 ID 含非法字符（路径分隔/上跳段/盘符），已拒绝：${JSON.stringify(name.slice(0, 64))}`,
    );
  }
}
