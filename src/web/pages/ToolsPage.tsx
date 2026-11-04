import { Suspense, lazy, useMemo } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { getToolMeta } from '@/lib/tools-registry';
import { useT } from '@/lib/i18n';
import ToolsHub from '@/pages/tools/ToolsHub';

import SimulatePage from '@/pages/SimulatePage';
import { usePageHeader } from '@/components/header-actions';
import { Button } from '@/components/ui/button';

const EncodeTool = lazy(() => import('@/pages/tools/EncodeTool'));
const MediaParseTool = lazy(() => import('@/pages/tools/MediaParseTool'));
const PluginDevTool = lazy(() => import('@/pages/tools/PluginDevTool'));
const ImageObfuscationTool = lazy(() => import('@/pages/tools/ImageObfuscationTool'));
const ImageEditTool = lazy(() => import('@/pages/tools/ImageEditTool'));

function ToolFallback() {
  return (
    <div className="flex flex-1 items-center justify-center py-16 text-slate-500">
      <Loader2 className="h-6 w-6 animate-spin" />
    </div>
  );
}

export default function ToolsPage() {
  const { toolId } = useParams<{ toolId?: string }>();
  const meta = getToolMeta(toolId);
  const navigate = useNavigate();
  const t = useT();

  /*
   * 顶栏默认按路由显示「工具」，进了具体工具就换成工具名，并补一个返回键。
   *
   * 工具是 /tools 的子页，但这一层的顶栏原本只有侧栏开合按钮——进了工具就只能
   * 开侧栏再点「工具」才能回去，鼠标路径特别绕。返回键走顶栏的 leading 插槽
   * （与 AI 会话页同一个位置、同一套样式），点击回工具列表首页。
   *
   * 用 navigate('/tools') 而不是 navigate(-1)：直接粘 URL / 刷新进来时历史里
   * 没有上一页，navigate(-1) 会把人甩出应用外。
   */
  usePageHeader(
    () =>
      toolId && meta?.titleKey
        ? {
            title: t(meta.titleKey),
            leading: (
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0 text-slate-600 hover:bg-white/35"
                title={t('tools.backToList')}
                aria-label={t('tools.backToList')}
                data-tour="tool-back"
                onClick={() => navigate('/tools')}
              >
                <ArrowLeft className="h-4 w-4" />
              </Button>
            ),
          }
        : null,
    [toolId, meta, navigate],
  );

  const body = useMemo(() => {
    if (!toolId) return <ToolsHub />;
    if (!meta) return <Navigate to="/tools" replace />;
    if (toolId === 'encode') {
      return (
        <Suspense fallback={<ToolFallback />}>
          <EncodeTool />
        </Suspense>
      );
    }
    if (toolId === 'media') {
      return (
        <Suspense fallback={<ToolFallback />}>
          <MediaParseTool />
        </Suspense>
      );
    }
    if (toolId === 'plugin-dev') {
      return (
        <Suspense fallback={<ToolFallback />}>
          <PluginDevTool />
        </Suspense>
      );
    }
    if (toolId === 'image-obf') {
      return (
        <Suspense fallback={<ToolFallback />}>
          <ImageObfuscationTool />
        </Suspense>
      );
    }
    if (toolId === 'image-edit') {
      return (
        <Suspense fallback={<ToolFallback />}>
          <ImageEditTool />
        </Suspense>
      );
    }
    if (toolId === 'simulate') {
      return <SimulatePage />;
    }
    return <Navigate to="/tools" replace />;
  }, [toolId, meta]);

  if (!toolId) return body;

  return (
    // 具体工具的标题已由顶栏显示，这里直接放工具本体
    <div className="flex h-full min-h-0 w-full flex-col">
      <div className="flex min-h-0 flex-1 flex-col">{body}</div>
    </div>
  );
}
