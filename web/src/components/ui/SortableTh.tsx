import React from "react";

type Props = {
  column: string;
  label: string;
  align?: "start" | "end";
  onSort: (column: string) => void;
  indicator: (column: string) => string;
};

export default function SortableTh({ column, label, align = "start", onSort, indicator }: Props) {
  return (
    <th
      scope="col"
      className={`table-sortable ${align === "end" ? "text-end" : ""}`}
      onClick={() => onSort(column)}
      role="columnheader"
    >
      {label}
      <span className="sort-indicator opacity-75 ms-1">{indicator(column)}</span>
    </th>
  );
}
