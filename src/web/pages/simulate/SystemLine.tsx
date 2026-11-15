/** QQ 风格的系统灰字提示（居中、淡灰、小字） */
export function SystemLine({ text }: { text: string }) {
  return (
    <div className="flex justify-center py-0.5">
      <span className="rounded-full bg-black/5 px-2.5 py-1 text-[12px] leading-none text-slate-400">
        {text}
      </span>
    </div>
  );
}
