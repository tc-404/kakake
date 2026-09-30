import { Toaster } from 'sonner';

export function AppToaster() {
  return (
    <Toaster
      position="top-center"
      richColors
      toastOptions={{
        className:
          'font-sans !rounded-2xl !border-white/50 !bg-white/70 !shadow-[0_8px_32px_rgba(15,40,60,0.12)] !backdrop-blur-xl',
      }}
    />
  );
}
