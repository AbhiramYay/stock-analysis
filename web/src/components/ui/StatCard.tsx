import React from "react";

type Variant = "default" | "success" | "danger" | "primary";

const valueClass: Record<Variant, string> = {
  default: "text-body",
  success: "text-success",
  danger: "text-danger",
  primary: "text-primary",
};

type Props = {
  label: string;
  value: React.ReactNode;
  variant?: Variant;
  icon?: string;
};

export default function StatCard({ label, value, variant = "default", icon }: Props) {
  return (
    <div className="col-sm-6 col-lg-4 col-xl">
      <div className="card h-100 border-0 shadow-sm stat-card">
        <div className="card-body">
          <div className="d-flex align-items-center gap-2 text-muted small text-uppercase fw-semibold mb-2">
            {icon && <i className={`bi ${icon}`} aria-hidden />}
            {label}
          </div>
          <div className={`fs-4 fw-bold mb-0 ${valueClass[variant]}`}>{value}</div>
        </div>
      </div>
    </div>
  );
}
