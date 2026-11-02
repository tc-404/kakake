import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { PATHS } from '../paths.js';

/**
 * 技能包管理器。
 *
 * 一个「技能」= 一个目录，目录内至少包含 `SKILL.md`（技能说明）。本模块负责：
 *   - 从各种奇奇怪怪的来源导入技能：单个 .md 文件、单个技能 zip、一个压缩包里含多个技能、
 *     压缩包里只有一个技能但文件/文件夹很多、甚至完全没有 SKILL.md 的代码项目；
 *   - 把每个技能落到 `data/skills/<name>/`（持久化、重启保留）；
 *   - 列出已安装技能、删除技能；
 *   - 生成注入到 AI 系统提示的「技能索引」，让 AI 知道有哪些技能、路径在哪、何时该读。
 */

export interface SkillMeta {
  /** 目录名，作为该技能的稳定 key（删除时用） */
  name: string;
  /** 展示名（取自 SKILL.md frontmatter 的 name / 首个标题 / 目录名） */
  displayName: string;
  /** 一句话说明 */
  description: string;
  /** 相对于项目根的目录，如 data/skills/xxx */
  root: string;
  /** 是否真的带 SKILL.md（没有的话当作知识库/资源目录处理） */
  hasSkillMd: boolean;
}

const SKILLS_DIR = PATHS.skills;

/** 单条消息最多展示的技能数量（避免技能极多时撑爆系统提示） */
const MAX_INDEXED_SKILLS = 60;

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/** 把任意字符串收拾成可用作目录名的标识 */
function sanitizeName(raw: string): string {
  const base = path.basename(raw).replace(/\.(zip|skill|md|markdown|txt)$/i, '');
  const cleaned = base
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}_-]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_')
    .slice(0, 48);
  return cleaned || 'skill';
}

function isZipBuffer(buf: Buffer): boolean {
  return buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
}

/** 解析 YAML frontmatter（仅支持顶层 `key: value`，足够读取 name/description） */
function parseFrontmatter(text: string): { data: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { data: {}, body: text };
  const data: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (kv) data[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return { data, body: text.slice(m[0].length) };
}

/** 从一份 SKILL.md 文本里推导展示名与说明 */
function deriveMeta(text: string, fallbackName: string): { displayName: string; description: string } {
  const { data, body } = parseFrontmatter(text);
  const displayName = (data.name || '').trim()
    || (/^#\s+(.+)$/m.exec(body)?.[1]?.trim())
    || fallbackName;
  const description = (data.description || '').trim()
    || body.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith('#') && !l.startsWith('---'))?.slice(0, 120)
    || '（无说明）';
  return { displayName, description };
}

/** 递归收集目录内所有名为 SKILL.md 的文件（大小写不敏感） */
function findSkillMds(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) findSkillMds(full, out);
    else if (e.name.toLowerCase() === 'skill.md') out.push(full);
  }
  return out;
}

/** 递归复制目录（已假定 src 来自受信任的导入流程，仅做基本防护） */
function copyDir(src: string, dest: string): void {
  ensureDir(dest);
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else {
      fs.mkdirSync(path.dirname(d), { recursive: true });
      fs.copyFileSync(s, d);
    }
  }
}

/** 给技能挑一个不冲突的目录名 */
function uniqueSkillName(base: string): string {
  ensureDir(SKILLS_DIR);
  let name = sanitizeName(base);
  let i = 2;
  while (fs.existsSync(path.join(SKILLS_DIR, name))) {
    name = `${sanitizeName(base)}_${i}`;
    i += 1;
  }
  return name;
}

/** 落地一个技能目录（srcDir）到 data/skills/<name>，返回元信息 */
function landSkill(srcDir: string, suggestedName: string): SkillMeta {
  const name = uniqueSkillName(suggestedName);
  const dest = path.join(SKILLS_DIR, name);
  copyDir(srcDir, dest);
  const skillMd = path.join(dest, 'SKILL.md');
  const hasSkillMd = fs.existsSync(skillMd);
  let displayName = suggestedName;
  let description = '（无说明）';
  if (hasSkillMd) {
    try {
      const { displayName: dn, description: ds } = deriveMeta(fs.readFileSync(skillMd, 'utf-8'), suggestedName);
      displayName = dn;
      description = ds;
    } catch { /* 读不到就退回默认 */ }
  } else {
    description = '（无 SKILL.md，作为知识库 / 资源目录处理）';
  }
  return { name, displayName, description, root: `data/skills/${name}`, hasSkillMd };
}

/** 安全地把 zip 的每个条目解出来（防 zip-slip），解压到 targetDir，返回解压根目录 */
function extractZipSafe(buf: Buffer, targetDir: string): void {
  ensureDir(targetDir);
  const zip = new AdmZip(buf);
  for (const entry of zip.getEntries()) {
    const rel = entry.entryName.replace(/\\/g, '/');
    if (rel.startsWith('/') || rel.includes('..')) continue; // 绝对路径或回退，跳过
    const target = path.resolve(targetDir, rel);
    const base = path.resolve(targetDir);
    if (target !== base && !target.startsWith(base + path.sep)) continue; // 越界，跳过
    if (entry.isDirectory) {
      ensureDir(target);
      continue;
    }
    const content = zip.readFile(entry);
    if (content == null) continue;
    ensureDir(path.dirname(target));
    fs.writeFileSync(target, content);
  }
}

/**
 * 从一段字节导入技能，返回本次导入的技能元信息列表。
 * 兼容：
 *   - 单 .md 文件（直接作为该技能的 SKILL.md）
 *   - 单技能 zip（SKILL.md 在根或某个子目录）
 *   - 多技能 zip（多个顶层目录各带 SKILL.md）
 *   - 没有任何 SKILL.md 的代码项目（整个压缩包当作一个技能）
 */
export function importSkillFromBuffer(buf: Buffer, origName: string): SkillMeta[] {
  const lower = origName.toLowerCase();

  // 情形一：单个 markdown 文件
  if (!isZipBuffer(buf) && (lower.endsWith('.md') || lower.endsWith('.markdown') || lower.endsWith('.txt'))) {
    const name = uniqueSkillName(origName);
    const dest = path.join(SKILLS_DIR, name);
    ensureDir(dest);
    const skillMdPath = path.join(dest, 'SKILL.md');
    fs.writeFileSync(skillMdPath, buf.toString('utf-8'));
    const { displayName, description } = deriveMeta(buf.toString('utf-8'), name);
    return [{ name, displayName, description, root: `data/skills/${name}`, hasSkillMd: true }];
  }

  // 情形二：zip（含 .skill.zip 等）
  const tmpRoot = path.join(PATHS.tmp, `skill-import-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  try {
    ensureDir(tmpRoot);
    extractZipSafe(buf, tmpRoot);

    const skillMds = findSkillMds(tmpRoot);
    const imported: SkillMeta[] = [];

    if (skillMds.length > 0) {
      // 每个 SKILL.md 所在目录 = 一个技能
      const seen = new Set<string>();
      for (const md of skillMds) {
        const skillRoot = path.dirname(md);
        const realRoot = fs.realpathSync(skillRoot);
        if (seen.has(realRoot)) continue;
        seen.add(realRoot);
        const folderName = path.basename(skillRoot);
        imported.push(landSkill(skillRoot, folderName));
      }
      return imported;
    }

    // 没有 SKILL.md：整个压缩包当作一个技能
    const topEntries = fs.readdirSync(tmpRoot, { withFileTypes: true });
    let srcDir: string;
    let suggested: string;
    if (topEntries.length === 1 && topEntries[0].isDirectory()) {
      srcDir = path.join(tmpRoot, topEntries[0].name);
      suggested = topEntries[0].name;
    } else {
      srcDir = tmpRoot;
      suggested = origName;
    }
    return [landSkill(srcDir, suggested)];
  } finally {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch { /* 清理失败忽略 */ }
  }
}

/** 列出已安装技能 */
export function listSkills(): SkillMeta[] {
  if (!fs.existsSync(SKILLS_DIR)) return [];
  const out: SkillMeta[] = [];
  for (const e of fs.readdirSync(SKILLS_DIR, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const dir = path.join(SKILLS_DIR, e.name);
    const skillMd = path.join(dir, 'SKILL.md');
    const hasSkillMd = fs.existsSync(skillMd);
    let displayName = e.name;
    let description = hasSkillMd ? '（无说明）' : '（无 SKILL.md，作为知识库 / 资源目录处理）';
    if (hasSkillMd) {
      try {
        const { displayName: dn, description: ds } = deriveMeta(fs.readFileSync(skillMd, 'utf-8'), e.name);
        displayName = dn;
        description = ds;
      } catch { /* 忽略 */ }
    }
    out.push({ name: e.name, displayName, description, root: `data/skills/${e.name}`, hasSkillMd });
  }
  return out.sort((a, b) => a.displayName.localeCompare(b.displayName, 'zh'));
}

/** 删除一个技能；返回是否删除成功 */
export function deleteSkill(name: string): boolean {
  // 仅允许已知的安全名，避免越界
  const safe = sanitizeName(name);
  if (safe !== name) return false;
  const dir = path.join(SKILLS_DIR, name);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

/**
 * 注入 AI 系统提示的技能索引。
 * 只列「名字 + 一句话说明 + 目录路径」，不把技能正文塞进上下文；
 * 让 AI 在任务相关时自行 read_file 对应 SKILL.md —— 这与业界技能（skill）机制一致，
 * 既能让已安装技能真正生效，又不会撑爆上下文。
 *
 * @param activeNames 本次要启用的技能名（用户在前端点选的）。为空 = 不启用任何技能，
 *   即「导入了但没点选就不生效」，避免一次把所有已安装技能塞进上下文。
 */
export function skillsSystemPrompt(activeNames: string[] = []): string {
  const all = listSkills();
  const skills = activeNames.length ? all.filter((s) => activeNames.includes(s.name)) : [];
  if (skills.length === 0) return '';
  const head = '【已安装技能 skills】以下技能已装入本机，位于 data/skills/ 下（每个技能是一个目录，通常含 SKILL.md）。当用户的任务与某技能相关时，**先 read_file 该技能目录里的 SKILL.md 并严格遵循其中的指引**；不相关的不要主动加载。当前已安装：';
  const lines = skills.slice(0, MAX_INDEXED_SKILLS).map((s) => {
    const tag = s.hasSkillMd ? '' : '（无 SKILL.md，按知识库/资源处理）';
    return `- ${s.displayName}：${s.description}${tag}\n  技能目录：${s.root}/（需要时读取其中的 SKILL.md）`;
  });
  const tail = skills.length > MAX_INDEXED_SKILLS
    ? `\n（还有 ${skills.length - MAX_INDEXED_SKILLS} 个技能未在此列出，可用 list_dir data/skills 查看全部）`
    : '';
  return `${head}\n${lines.join('\n')}${tail}`;
}
