import React, { useState } from "react";
import axios from "axios";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  Title,
  Tooltip,
  Legend,
} from "chart.js";
import { Bar } from "react-chartjs-2";
import { formatINR, formatPct } from "../utils/format";
import { useTableSort } from "../utils/tableSort";
import PageHeader from "../components/ui/PageHeader";
import LoadingState from "../components/ui/LoadingState";
import DataTable from "../components/ui/DataTable";
import SortableTh from "../components/ui/SortableTh";
import StatCard from "../components/ui/StatCard";

ChartJS.register(CategoryScale, LinearScale, BarElement, Title, Tooltip, Legend);

type StockRow = {
  symbol: string;
  quantity: number;
  openPrice: number;
  closePrice: number;
  currentPrice: number;
  pnlAbsolute: number;
  pnlPercent: number;
  holdingValue: number;
};

type PnLReport = {
  stocks: StockRow[];
  totalPnLAbsolute: number;
  totalPnLPercent: number;
  totalHoldingValue: number;
  bestPerformer: StockRow | null;
  worstPerformer: StockRow | null;
  period?: { from: string; to: string };
};

function formatPeriod(from: string, to: string): string {
  const opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "numeric" };
  return `${new Date(from).toLocaleDateString("en-IN", opts)} → ${new Date(to).toLocaleDateString("en-IN", opts)}`;
}

export default function PnLPage() {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [report, setReport] = useState<PnLReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const { handleSort, sort, indicator } = useTableSort("pnlPercent", "desc");

  async function fetchPnL(e?: React.FormEvent) {
    e?.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await axios.post("/api/pnl", { from, to });
      setReport(res.data);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Request failed";
      setReport(null);
      setError(message);
    } finally {
      setLoading(false);
    }
  }

  const chartData = () => {
    if (!report?.stocks?.length) return null;
    const stocks = [...report.stocks].sort((a, b) => b.pnlPercent - a.pnlPercent).slice(0, 12);
    const data = stocks.map((s) => Number(s.pnlPercent.toFixed(2)));
    return {
      labels: stocks.map((s) => s.symbol),
      datasets: [
        {
          label: "% PnL",
          data,
          backgroundColor: data.map((v) =>
            v >= 0 ? "rgba(25, 135, 84, 0.75)" : "rgba(220, 53, 69, 0.75)"
          ),
          borderRadius: 6,
        },
      ],
    };
  };

  const pnlVariant = (n: number) => (n >= 0 ? "success" : "danger") as const;

  return (
    <>
      <PageHeader
        title="Monthly PnL"
        subtitle="Compare period open vs close prices for each holding. Leave dates empty for last calendar month."
      />

      <div className="card border-0 shadow-sm mb-4">
        <div className="card-body">
          <form onSubmit={fetchPnL} className="row g-3 align-items-end">
            <div className="col-sm-6 col-md-3">
              <label htmlFor="pnl-from" className="form-label small text-muted mb-1">
                From
              </label>
              <input
                id="pnl-from"
                type="date"
                className="form-control"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
            </div>
            <div className="col-sm-6 col-md-3">
              <label htmlFor="pnl-to" className="form-label small text-muted mb-1">
                To
              </label>
              <input
                id="pnl-to"
                type="date"
                className="form-control"
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
            </div>
            <div className="col-auto">
              <button type="submit" className="btn btn-primary" disabled={loading}>
                {loading ? (
                  <>
                    <span className="spinner-border spinner-border-sm me-2" aria-hidden />
                    Running…
                  </>
                ) : (
                  <>
                    <i className="bi bi-play-fill me-1" aria-hidden />
                    Run PnL
                  </>
                )}
              </button>
            </div>
          </form>
        </div>
      </div>

      {loading && !report && <LoadingState message="Computing monthly PnL…" />}

      {error && (
        <div className="alert alert-danger" role="alert">
          <i className="bi bi-exclamation-triangle me-2" aria-hidden />
          {error}
        </div>
      )}

      {report && report.totalPnLAbsolute !== undefined && (
        <>
          {report.period && (
            <p className="text-muted mb-3">
              <i className="bi bi-calendar3 me-2" aria-hidden />
              {formatPeriod(report.period.from, report.period.to)}
            </p>
          )}

          <div className="card border-0 shadow-sm mb-4">
            <div className="card-header bg-white border-bottom py-3">
              <h2 className="h6 mb-0 fw-semibold">Portfolio Summary</h2>
            </div>
            <div className="card-body">
              <div className="row g-3">
                <StatCard
                  label="Total PnL"
                  value={formatINR(report.totalPnLAbsolute)}
                  variant={pnlVariant(report.totalPnLAbsolute)}
                  icon="bi-currency-rupee"
                />
                <StatCard
                  label="PnL %"
                  value={formatPct(report.totalPnLPercent)}
                  variant={pnlVariant(report.totalPnLPercent)}
                  icon="bi-percent"
                />
                <StatCard
                  label="Holding Value"
                  value={formatINR(report.totalHoldingValue)}
                  icon="bi-pie-chart"
                />
                {report.bestPerformer && (
                  <StatCard
                    label="Best"
                    value={`${report.bestPerformer.symbol} (${formatPct(report.bestPerformer.pnlPercent)})`}
                    variant="success"
                    icon="bi-trophy"
                  />
                )}
                {report.worstPerformer && (
                  <StatCard
                    label="Worst"
                    value={`${report.worstPerformer.symbol} (${formatPct(report.worstPerformer.pnlPercent)})`}
                    variant="danger"
                    icon="bi-graph-down"
                  />
                )}
              </div>
            </div>
          </div>

          {chartData() && (
            <div className="card border-0 shadow-sm mb-4 chart-card">
              <div className="card-header bg-white border-bottom py-3">
                <h2 className="h6 mb-0 fw-semibold">Top stocks by % PnL</h2>
              </div>
              <div className="card-body">
                <Bar
                  data={chartData()!}
                  options={{
                    responsive: true,
                    maintainAspectRatio: true,
                    plugins: { legend: { display: false } },
                    scales: {
                      y: { ticks: { callback: (v) => `${v}%` } },
                    },
                  }}
                />
              </div>
            </div>
          )}

          {report.stocks.length > 0 && (
            <DataTable className="mb-4">
              <thead className="table-light">
                <tr>
                  <SortableTh column="symbol" label="Symbol" onSort={handleSort} indicator={indicator} />
                  <SortableTh column="quantity" label="Qty" align="end" onSort={handleSort} indicator={indicator} />
                  <SortableTh column="openPrice" label="Open ₹" align="end" onSort={handleSort} indicator={indicator} />
                  <SortableTh column="closePrice" label="Close ₹" align="end" onSort={handleSort} indicator={indicator} />
                  <SortableTh column="currentPrice" label="Current ₹" align="end" onSort={handleSort} indicator={indicator} />
                  <SortableTh column="pnlAbsolute" label="PnL ₹" align="end" onSort={handleSort} indicator={indicator} />
                  <SortableTh column="pnlPercent" label="PnL %" align="end" onSort={handleSort} indicator={indicator} />
                  <SortableTh column="holdingValue" label="Holding ₹" align="end" onSort={handleSort} indicator={indicator} />
                </tr>
              </thead>
              <tbody>
                {sort(report.stocks).map((s) => (
                  <tr key={s.symbol}>
                    <td className="fw-semibold">{s.symbol}</td>
                    <td className="text-end">{s.quantity}</td>
                    <td className="text-end">{formatINR(s.openPrice)}</td>
                    <td className="text-end">{formatINR(s.closePrice)}</td>
                    <td className="text-end">{formatINR(s.currentPrice)}</td>
                    <td className={`text-end fw-medium ${s.pnlAbsolute >= 0 ? "text-success" : "text-danger"}`}>
                      {formatINR(s.pnlAbsolute)}
                    </td>
                    <td className={`text-end fw-medium ${s.pnlPercent >= 0 ? "text-success" : "text-danger"}`}>
                      {formatPct(s.pnlPercent)}
                    </td>
                    <td className="text-end">{formatINR(s.holdingValue)}</td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          )}
        </>
      )}
    </>
  );
}
