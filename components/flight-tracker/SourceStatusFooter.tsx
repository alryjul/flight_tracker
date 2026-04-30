"use client";

type SourceStatusFooterProps = {
  dataSource: string;
};

export function SourceStatusFooter({ dataSource }: SourceStatusFooterProps) {
  return (
    <div className="flex items-center justify-between text-[10px] text-muted-foreground">
      <span className="uppercase tracking-wider">Source</span>
      <span className="truncate tabular-nums">{dataSource}</span>
    </div>
  );
}
