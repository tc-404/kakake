import { Suspense, lazy, useMemo } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { getToolMeta } from '@/lib/tools-registry';
import ToolsHub from '@/pages/tools/ToolsHub';

import SimulatePage from '@/pages/SimulatePage';
import { usePageHeader } from '@/components/header-actions';

const EncodeTool = lazy(() => import('@/pages/tools/EncodeTool'));
const MediaParseTool = lazy(() => import('@/pages/tools/MediaParseTool'));
const PluginDevTool = lazy(() => import('@/pages/tools/PluginDevTool'));

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

  // 顶栏默认按路由显示「工具」，进了具体工具就换成工具名
  usePageHeader(() => (toolId && meta?.title ? { title: meta.title } : null), [toolId, meta]);

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
