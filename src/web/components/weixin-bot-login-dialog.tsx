import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, QrCode } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { ConnectionStatus } from '@/lib/types';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';

export function WeixinBotLoginDialog({
  open,
  conn,
  onClose,
  onLoggedIn,
}: {
  open: boolean;
  conn: ConnectionStatus | null;
  onClose: () => void;
  onLoggedIn: (connections?: ConnectionStatus[]) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [qrImg, setQrImg] = useState('');
  const [loginUrl, setLoginUrl] = useState('');
  const [statusHint, setStatusHint] = useState('正在获取二维码…');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stoppedRef = useRef(false);

  const stopPoll = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const startLogin = useCallback(async () => {
    if (!conn) return;
    stoppedRef.current = false;
    stopPoll();
    setLoading(true);
    setQrImg('');
    setLoginUrl('');
    setStatusHint('正在获取二维码…');
    try {
      const r = await api.connections.weixinQrcode(conn.id);
      if (!r.ok || !r.qrcode) {
        toast.error(r.message || '获取二维码失败');
        setStatusHint(r.message || '获取二维码失败');
        return;
      }
      const url = r.loginUrl || r.qrcodeImgContent || '';
      setLoginUrl(url);
      // qrcode_img_content 是 liteapp 登录 URL，不是图片；后端已据此生成二维码 data URL
      if (r.qrImageDataUrl) {
        setQrImg(r.qrImageDataUrl);
      } else if (url) {
        toast.error('二维码图片生成失败，请用下方链接');
      }
      setStatusHint('请使用微信扫码，并在手机上确认');

      pollRef.current = setInterval(async () => {
        if (stoppedRef.current || !conn) return;
        try {
          const st = await api.connections.weixinQrcodeStatus(conn.id, r.qrcode!);
          if (!st.ok) return;
          if (st.status === 'scaned') {
            setStatusHint('已扫码，请在手机上确认…');
          } else if (st.status === 'expired') {
            setStatusHint('二维码已过期，正在刷新…');
            stopPoll();
            void startLogin();
          } else if (st.status === 'confirmed') {
            stopPoll();
            toast.success(`登录成功${st.accountId ? ` · ${st.accountId}` : ''}`);
            onLoggedIn(st.connections);
            onClose();
          }
        } catch {
          /* ignore transient poll errors */
        }
      }, 1500);
    } catch (e) {
      toast.error(String(e));
      setStatusHint(String(e));
    } finally {
      setLoading(false);
    }
  }, [conn, onClose, onLoggedIn, stopPoll]);

  useEffect(() => {
    if (!open || !conn) return;
    void startLogin();
    return () => {
      stoppedRef.current = true;
      stopPoll();
    };
  }, [open, conn?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <QrCode className="h-4 w-4" />
            微信 AI×BOT 扫码登录
          </DialogTitle>
          <DialogDescription>
            {conn?.name || '微信 AI×BOT'} · 使用微信扫描下方二维码完成 iLink 登录
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col items-center gap-3 py-2">
          {qrImg ? (
            <img
              src={qrImg}
              alt="微信登录二维码"
              className="h-52 w-52 rounded-lg border border-white/40 bg-white object-contain p-2"
            />
          ) : (
            <div className="flex h-52 w-52 items-center justify-center rounded-lg border border-dashed border-white/40 bg-white/20">
              {loading ? <Loader2 className="h-6 w-6 animate-spin text-slate-500" /> : null}
            </div>
          )}
          <p className="text-center text-sm text-slate-600">{statusHint}</p>
          {loginUrl ? (
            <a
              href={loginUrl}
              target="_blank"
              rel="noreferrer"
              className="max-w-full truncate text-xs text-sky-600 underline"
              title={loginUrl}
            >
              备用：浏览器打开登录链接
            </a>
          ) : null}
        </div>
        <DialogFooter className="gap-2 sm:gap-0">
          <Button type="button" variant="outline" onClick={onClose}>关闭</Button>
          <Button type="button" onClick={() => void startLogin()} disabled={loading}>
            {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            刷新二维码
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
