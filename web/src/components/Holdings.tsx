import React, { useEffect, useState } from "react";
import axios from "axios";
import { formatINR } from "../utils/format";
import { useTableSort } from "../utils/tableSort";
import PageHeader from "./ui/PageHeader";
import LoadingState from "./ui/LoadingState";
import DataTable from "./ui/DataTable";
import SortableTh from "./ui/SortableTh";

type Holding = {
  symbol: string;
  quantity: number;
  averagePrice: number;
  lastPrice: number;
  currentValue: number;
  pnl: number;
  weight: number;
};

export default function Holdings() {
  const [holdings, setHoldings] = useState<Holding[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { handleSort, sort, indicator } = useTableSort("weight", "desc");

  useEffect(() => {
    setLoading(true);
    axios
      .get("/api/holdings")
      .then((r) => setHoldings(r.data.holdings))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  return (
    <>
      <PageHeader
        title="Current Holdings"
        subtitle="Live Zerodha portfolio with weights, values, and unrealised PnL."
      />

      {loading && <LoadingState message="Loading holdings…" />}
      {error && (
        <div className="alert alert-danger d-flex align-items-center gap-2" role="alert">
          <i className="bi bi-exclamation-triangle-fill" aria-hidden />
          {error}
        </div>
      )}
      {!loading && !error && holdings?.length === 0 && (
        <div className="alert alert-secondary">No holdings found.</div>
      )}

      {!loading && !error && holdings && holdings.length > 0 && (
        <DataTable>
          <thead className="table-light">
            <tr>
              <SortableTh column="symbol" label="Symbol" onSort={handleSort} indicator={indicator} />
              <SortableTh column="quantity" label="Qty" align="end" onSort={handleSort} indicator={indicator} />
              <SortableTh column="averagePrice" label="Avg" align="end" onSort={handleSort} indicator={indicator} />
              <SortableTh column="lastPrice" label="LTP" align="end" onSort={handleSort} indicator={indicator} />
              <SortableTh column="currentValue" label="Value" align="end" onSort={handleSort} indicator={indicator} />
              <SortableTh column="pnl" label="PnL" align="end" onSort={handleSort} indicator={indicator} />
              <SortableTh column="weight" label="Weight %" align="end" onSort={handleSort} indicator={indicator} />
            </tr>
          </thead>
          <tbody>
            {sort(holdings).map((h) => (
              <tr key={h.symbol}>
                <td className="fw-semibold">{h.symbol}</td>
                <td className="text-end">{h.quantity}</td>
                <td className="text-end">{formatINR(h.averagePrice)}</td>
                <td className="text-end">{formatINR(h.lastPrice)}</td>
                <td className="text-end">{formatINR(h.currentValue)}</td>
                <td className={`text-end fw-medium ${h.pnl >= 0 ? "text-success" : "text-danger"}`}>
                  {formatINR(h.pnl)}
                </td>
                <td className="text-end">
                  <span className="badge text-bg-light border">{h.weight.toFixed(2)}%</span>
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}
    </>
  );
}
