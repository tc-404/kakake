import { Suspense } from 'react';
import { Loader2 } from 'lucide-react';
import { useT } from '@/lib/i18n';
import { AmbientVideo } from '@/components/ambient-video';
import { BackgroundPresetLayer } from '@/components/background-preset-layer';
import LoginPageInner from './login-inner';

export default function LoginPage() {
  const t = useT();
  return (
    <Suspense
      fallback={
        <div className="kk-login-ambient flex h-full min-h-[100dvh] flex-col items-center justify-center gap-3">
          <AmbientVideo />
          <BackgroundPresetLayer />
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">{t('label.loading')}</p>
        </div>
      }
    >
      <LoginPageInner />
    </Suspense>
  );
}
