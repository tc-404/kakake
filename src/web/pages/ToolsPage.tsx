import { Suspense, lazy, useMemo } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { getToolMeta } from '@/lib/tools-registry';
import ToolsHub from '@/pages/tools/ToolsHub';

import SimulatePage from '@/pages/SimulatePage';

const EncodeTool = lazy(() => import('@/pages/tools/EncodeTool'));
const MediaParseTool = lazy(() => import('@/pages/tools/MediaParseTool'));
const PluginDevTool = lazy(() => import('@/pages/tools/PluginDevTool'));
const ZeppStepsTool = lazy(() => import('@/pages/tools/ZeppStepsTool'));

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
    if (toolId === 'zepp-steps') {
      return (
        <Suspense fallback={<ToolFallback />}>
          <ZeppStepsTool />
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
    <div className="flex h-full min-h-0 w-full flex-col gap-3 md:gap-4">
      <div className="hidden shrink-0 md:block">
        <h1 className="kk-page-title text-xl md:text-[1.75rem]">{meta?.title}</h1>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">{body}</div>
    </div>
  );
}
