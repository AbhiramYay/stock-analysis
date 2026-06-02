import React from "react";

type Props = {
  children: React.ReactNode;
  className?: string;
};

/** Responsive Bootstrap table wrapper */
export default function DataTable({ children, className = "" }: Props) {
  return (
    <div className={`table-responsive rounded-3 border shadow-sm ${className}`}>
      <table className="table table-hover table-striped align-middle mb-0">{children}</table>
    </div>
  );
}
