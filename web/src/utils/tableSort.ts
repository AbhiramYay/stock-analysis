import { useState, useCallback } from "react";

export function compareValues(
  aVal: unknown,
  bVal: unknown,
  column: string,
  order: "asc" | "desc"
): number {
  const empty = column === "symbol" || column === "sector" || column === "sentimentLabel" || column === "recommendedAction" || column === "action" ? "" : 0;
  const a = aVal ?? empty;
  const b = bVal ?? empty;

  let cmp: number;
  if (typeof a === "string" && typeof b === "string") {
    cmp = a.localeCompare(b);
  } else {
    cmp = Number(a) - Number(b);
  }
  return order === "asc" ? cmp : -cmp;
}

export function sortRows<T extends object>(
  rows: T[],
  column: string,
  order: "asc" | "desc"
): T[] {
  return [...rows].sort((a, b) =>
    compareValues(
      (a as Record<string, unknown>)[column],
      (b as Record<string, unknown>)[column],
      column,
      order
    )
  );
}

export function getSortIndicator(
  sortColumn: string,
  sortOrder: "asc" | "desc",
  column: string
): string {
  if (sortColumn !== column) return " ⇅";
  return sortOrder === "asc" ? " ↑" : " ↓";
}

export function useTableSort(
  defaultColumn: string,
  defaultOrder: "asc" | "desc" = "desc",
  newColumnOrder: "asc" | "desc" = "desc"
) {
  const [sortColumn, setSortColumn] = useState(defaultColumn);
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">(defaultOrder);

  const handleSort = useCallback(
    (column: string) => {
      if (sortColumn === column) {
        setSortOrder((o) => (o === "asc" ? "desc" : "asc"));
      } else {
        setSortColumn(column);
        setSortOrder(newColumnOrder);
      }
    },
    [sortColumn, newColumnOrder]
  );

  const indicator = useCallback(
    (column: string) => getSortIndicator(sortColumn, sortOrder, column),
    [sortColumn, sortOrder]
  );

  const sort = useCallback(
    <T extends object>(rows: T[]) =>
      sortRows(rows, sortColumn, sortOrder),
    [sortColumn, sortOrder]
  );

  return { sortColumn, sortOrder, handleSort, sort, indicator };
}
