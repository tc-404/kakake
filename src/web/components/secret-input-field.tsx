import { useMemo, useState } from 'react';
import { Copy, Eye, EyeOff } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { copyToClipboard } from '@/lib/clipboard';
import { useT } from '@/lib/i18n';
import { errText } from '@/lib/server-error';

function maskLengthOf(real: number): number {
  if (real < 18) return real;
  if (real <= 30) {
    const delta = 1 + Math.floor(Math.random() * 3);
    return Math.random() < 0.5 ? Math.max(1, real - delta) : real + delta;
  }
  return 20 + Math.floor(Math.random() * 11);
}

export function SecretInputField({ value, placeholder, hasSaved, secretLength, readSecret, onChange, disabled }: {
  value: string;
  placeholder?: string;
  hasSaved?: boolean;
  secretLength?: number;
  readSecret?: () => Promise<string>;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const t = useT();
  const [visible, setVisible] = useState(false);
  const [plain, setPlain] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const mask = useMemo(() => '•'.repeat(maskLengthOf(secretLength ?? 0)), [secretLength]);
  const shown = value || (visible && plain !== null ? plain : hasSaved ? mask : '');

  const loadSecret = async (): Promise<string | null> => {
    if (plain !== null) return plain;
    if (!readSecret) return null;
    setLoading(true);
    try {
      const secret = await readSecret();
      setPlain(secret);
      return secret;
    } catch (e) {
      toast.error(errText(e));
      return null;
    } finally {
      setLoading(false);
    }
  };

  const toggleVisible = async () => {
    if (visible) {
      setVisible(false);
      return;
    }
    if (value) {
      setVisible(true);
      return;
    }
    const secret = await loadSecret();
    if (secret !== null) setVisible(true);
  };

  const copySecret = async () => {
    const secret = value || await loadSecret();
    if (!secret) return;
    const ok = await copyToClipboard(secret);
    if (ok) toast.success(t('connections.copied'));
    else toast.error(t('connections.copyFailed'));
  };

  return (
    <div className="flex items-center gap-1">
      <Input
        className="min-w-0 flex-1"
        type={visible ? 'text' : 'password'}
        value={shown}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete="new-password"
        onChange={(e) => {
          setVisible(true);
          onChange(e.target.value);
        }}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-8 w-8 shrink-0"
        disabled={disabled || loading}
        title={t('btn.copy')}
        aria-label={t('btn.copy')}
        onClick={() => void copySecret()}
      >
        <Copy className="h-3.5 w-3.5" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-8 w-8 shrink-0"
        disabled={disabled || loading}
        title={visible ? t('connections.hideSecret') : t('connections.showSecret')}
        aria-label={visible ? t('connections.hideSecret') : t('connections.showSecret')}
        onClick={() => void toggleVisible()}
      >
        {visible ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
      </Button>
    </div>
  );
}
