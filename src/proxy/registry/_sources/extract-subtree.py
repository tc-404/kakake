"""从仓库压缩包中按前缀提取文件到本地目录。

unzip 的通配符不跨 `/`，无法一次性拉出深层子树，故用 Python zipfile 精确匹配前缀。
用法: python extract-subtree.py <zip路径> <zip内前缀> <输出目录>
"""

import os
import sys
import zipfile


def main() -> int:
    if len(sys.argv) != 4:
        print(__doc__)
        return 2
    zip_path, prefix, out_dir = sys.argv[1], sys.argv[2].replace('\\', '/'), sys.argv[3]
    # 丢弃最外层目录（GitHub 压缩包统一形如 <repo>-<branch>/）
    strip_root = True
    count = 0
    os.makedirs(out_dir, exist_ok=True)
    with zipfile.ZipFile(zip_path) as zf:
        for info in zf.infolist():
            name = info.filename
            if not name.startswith(prefix):
                continue
            if info.is_dir():
                continue
            rel = name[len(prefix):] if prefix else name
            if strip_root:
                parts = name.split('/')
                # 去掉顶层目录（仅当存在剩余路径时）
                rel = '/'.join(parts[1:]) if len(parts) > 1 else parts[0]
            target = os.path.join(out_dir, rel)
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with zf.open(info) as src, open(target, 'wb') as dst:
                dst.write(src.read())
            count += 1
    print(f'extracted {count} files -> {out_dir}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
