import React from "react";

type Props = {
  title: string;
  subtitle?: string;
  children?: React.ReactNode;
};

export default function PageHeader({ title, subtitle, children }: Props) {
  return (
    <div className="d-flex flex-column flex-md-row justify-content-between align-items-md-start gap-3 mb-4">
      <div>
        <h1 className="h3 fw-semibold mb-1">{title}</h1>
        {subtitle && <p className="text-muted mb-0 col-lg-10">{subtitle}</p>}
      </div>
      {children && <div className="flex-shrink-0">{children}</div>}
    </div>
  );
}
