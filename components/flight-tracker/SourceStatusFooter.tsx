"use client";

import { memo } from "react";

type SourceStatusFooterProps = {
  dataSource: string;
};

function SourceStatusFooterImpl({ dataSource }: SourceStatusFooterProps) {
  return (
    <div className="flex items-center justify-between text-[10px] text-muted-foreground">
      <span className="uppercase tracking-wider">Source</span>
      <span className="truncate tabular-nums">{dataSource}</span>
    </div>
  );
}

export const SourceStatusFooter = memo(SourceStatusFooterImpl);
