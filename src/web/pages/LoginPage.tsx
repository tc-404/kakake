import { Suspense } from 'react';
import { Loader2 } from 'lucide-react';
import { AmbientVideo } from '@/components/ambient-video';
import LoginPageInner from './login-inner';

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="kk-login-ambient flex h-full min-h-[100dvh] flex-col items-center justify-center gap-3">
          <AmbientVideo />
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">加载中…</p>
        </div>
      }
    >
      <LoginPageInner />
    </Suspense>
  );
}
