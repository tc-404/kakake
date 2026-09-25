import {
  isValidElement,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Copy } from 'lucide-react';
import { toast } from 'sonner';
import { copyToClipboard } from '@/lib/clipboard';
import { bindCodeScrollPassthrough } from '@/lib/code-scroll';
import { cn } from '@/lib/utils';

/** 递归取出节点内的纯文本（用于复制代码块） */
function toText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(toText).join('');
  if (isValidElement(node)) {
    return toText((node.props as { children?: ReactNode }).children);
  }
  return '';
}

/** 链接：外链走新窗口，避免把单页应用导航走 */
function MarkdownLink({ href, children }: ComponentProps<'a'>) {
  const url = typeof href === 'string' ? href : '';
  if (!url) return <span>{children}</span>;

  // 站内锚点 / 相对路径：原样跳转
  if (url.startsWith('#')) {
    return <a href={url}>{children}</a>;
  }

  // 邮件 / 电话：不加新窗口
  if (url.startsWith('mailto:') || url.startsWith('tel:')) {
    return <a href={url}>{children}</a>;
  }

  if (/^https?:\/\//i.test(url)) {
    return (
      <a href={url} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  }

  // 其它协议（javascript: 等）只显示文字，不给可点
  return <span>{children}</span>;
}

/** 代码块：顶部语言标签 + 复制按钮，视觉与 CodeFileBlock 一致 */
function MarkdownPre({ children }: ComponentProps<'pre'>) {
  const [copied, setCopied] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);

  // react-markdown 会把围栏代码块渲染成 <pre><code class="language-xxx">，这里取它的语言与内容
  let language = '';
  if (isValidElement(children)) {
    const props = children.props as { className?: string; children?: ReactNode };
    language = /language-([\w+-]+)/.exec(props.className ?? '')?.[1] ?? '';
  }
  const code = toText(children);

  useEffect(() => {
    const el = preRef.current;
    if (!el) return;
    return bindCodeScrollPassthrough(el);
  }, []);

  async function onCopy() {
    const ok = await copyToClipboard(code);
    if (ok) {
      setCopied(true);
      toast.success('已复制代码');
      window.setTimeout(() => setCopied(false), 1600);
    } else {
      toast.error('复制失败');
    }
  }

  return (
    <div className="kk-md-code">
      <div className="kk-md-code-head">
        <span className="kk-md-code-lang">{language || '代码'}</span>
        <button type="button" onClick={() => void onCopy()} className="kk-md-code-copy">
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          复制
        </button>
      </div>
      <pre ref={preRef} className="kk-md-code-body">
        <code>{code}</code>
      </pre>
    </div>
  );
}

/** 表格：外面套一层可横向滚动的容器，避免撑破排版 */
function MarkdownTable({ children }: ComponentProps<'table'>) {
  return (
    <div className="kk-md-table-wrap">
      <table>{children}</table>
    </div>
  );
}

function MarkdownImage({ src, alt }: ComponentProps<'img'>) {
  return (
    <img
      src={typeof src === 'string' ? src : undefined}
      alt={typeof alt === 'string' ? alt : ''}
      loading="lazy"
      decoding="async"
    />
  );
}

/**
 * 统一 Markdown 渲染器：教程页 / 公告页 / 插件说明弹窗共用。
 * 样式来自 globals.css 的 .kk-md-prose，这里只补结构与交互。
 */
export function MarkdownContent({
  markdown,
  className,
}: {
  markdown: string;
  className?: string;
}) {
  return (
    <div className={cn('kk-md-prose', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: MarkdownLink,
          pre: MarkdownPre,
          table: MarkdownTable,
          img: MarkdownImage,
        }}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
}
