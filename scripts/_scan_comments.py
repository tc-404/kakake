# -*- coding: utf-8 -*-
# 扫描 src/ 下超过 4 行的连续注释块
import os

results = {}
for root, dirs, files in os.walk('src'):
    dirs[:] = [d for d in dirs if d != '_sources' and d != 'node_modules']
    for fn in files:
        if not fn.endswith(('.ts', '.tsx', '.mjs')):
            continue
        p = os.path.join(root, fn).replace(os.sep, '/')
        lines = open(p, encoding='utf-8').read().split('\n')
        i = 0
        while i < len(lines):
            s = lines[i]
            if s.strip().startswith('/*'):
                j = i
                while j < len(lines) and '*/' not in lines[j]:
                    j += 1
                # 正文行 = 块内去掉 /** 与 */ 分隔符后的行数
                n = j - i + 1 - 2
                if n > 4:
                    results.setdefault(p, []).append((i + 1, n))
                i = j + 1
            elif s.strip().startswith('//'):
                j = i
                while j < len(lines) and lines[j].strip().startswith('//'):
                    j += 1
                n = j - i
                if n > 4:
                    results.setdefault(p, []).append((i + 1, n))
                i = j
            else:
                i += 1

total = sum(len(v) for v in results.values())
print('共 %d 个文件、%d 个超过4行的注释块' % (len(results), total))
print()
for p, blocks in sorted(results.items(), key=lambda kv: -len(kv[1])):
    print('%s: %d 处 -> %s' % (p, len(blocks), ' '.join('L%d(%d行)' % b for b in blocks)))
