"use client";

import { memo } from "react";

type SourceStatusFooterProps = {
  dataSource: string;
};

function SourceStatusFooterImpl({ dataSource }: SourceStatusFooterProps) {
  return (
    <p className="truncate text-[10px] text-muted-foreground">
      Source: <span className="tabular-nums">{dataSource}</span>
    </p>
  );
}

export const SourceStatusFooter = memo(SourceStatusFooterImpl);
