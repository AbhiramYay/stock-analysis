import React, { useEffect, useState } from "react";
import axios from "axios";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  Title,
  Tooltip,
  Legend,
  ArcElement,
} from "chart.js";
import { Bar, Pie } from "react-chartjs-2";
import { useTableSort } from "../utils/tableSort";
import PageHeader from "../components/ui/PageHeader";
import LoadingState from "../components/ui/LoadingState";
import DataTable from "../components/ui/DataTable";
import SortableTh from "../components/ui/SortableTh";
import type { PortfolioRiskSentimentReport } from "../../../src/types";

type RiskPageReport = Pick<PortfolioRiskSentimentReport, "benchmarkSymbol" | "sectorWeights" | "stockSummaries">;

ChartJS.register(CategoryScale, LinearScale, BarElement, Title, Tooltip, Legend, ArcElement);

function sentimentBadge(label: string) {
  if (label === "positive") return "success";
  if (label === "negative") return "danger";
  return "secondary";
}

function actionBadge(action: string) {
  if (action === "REDUCE" || action === "CONSIDER REDUCE") return "danger";
  if (action === "INCREASE" || action === "CONSIDER INCREASE") return "success";
  return "secondary";
}

export default function RiskPage() {
  const [lookback, setLookback] = useState(90);
  const [report, setReport] = useState<RiskPageReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const { handleSort, sort, indicator } = useTableSort("priorityRank", "asc");

  async function fetchRisk() {
    setLoading(true);
    setError(null);
    try {
      const res = await axios.get<RiskPageReport>(`/api/risk?lookback=${lookback}`);
      setReport(res.data);
    } catch (err: any) {
      setReport(null);
      setError(err instanceof Error ? err.message : "Unable to load risk analysis.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchRisk();
  }, []);

  const sectorChartData = () => {
    if (!report?.sectorWeights) return null;
    const entries = Object.entries(report.sectorWeights).sort((a, b) => b[1] - a[1]);
    return {
      labels: entries.map((e) => e[0]),
      datasets: [
        {
          label: "Sector %",
          data: entries.map((e) => Number(Number(e[1]).toFixed(2))),
          backgroundColor: [
            "#0d6efd",
            "#6610f2",
            "#6f42c1",
            "#d63384",
            "#dc3545",
            "#fd7e14",
            "#ffc107",
            "#198754",
            "#20c997",
            "#0dcaf0",
          ],
        },
      ],
    };
  };

  const volatilityChartData = () => {
    if (!report?.stockSummaries?.length) return null;
    const items = [...report.stockSummaries]
      .sort((a, b) => b.volatilityAnnual - a.volatilityAnnual)
      .slice(0, 12);
    return {
      labels: items.map((i) => i.symbol),
      datasets: [
        {
          label: "Annual Volatility %",
          data: items.map((i) => i.volatilityAnnual),
          backgroundColor: "rgba(13, 110, 253, 0.7)",
          borderRadius: 6,
        },
      ],
    };
  };

  return (
    <>
      <PageHeader
        title="Risk & Sentiment"
        subtitle="Volatility, beta, sector concentration, and news sentiment for your holdings."
      />

      <div className="card border-0 shadow-sm mb-4">
        <div className="card-body d-flex flex-wrap align-items-end gap-3">
          <div>
            <label htmlFor="lookback" className="form-label small text-muted mb-1">
              Lookback (days)
            </label>
            <input
              id="lookback"
              type="number"
              min={30}
              max={365}
              className="form-control"
              style={{ width: "7rem" }}
              value={lookback}
              onChange={(e) => setLookback(Number(e.target.value))}
            />
          </div>
          <button type="button" className="btn btn-primary" onClick={fetchRisk} disabled={loading}>
            {loading ? (
              <>
                <span className="spinner-border spinner-border-sm me-2" aria-hidden />
                Loading…
              </>
            ) : (
              <>
                <i className="bi bi-arrow-clockwise me-1" aria-hidden />
                Refresh
              </>
            )}
          </button>
        </div>
      </div>

      <div className="alert alert-info mb-4" role="note">
        <strong>How stocks are ranked within each priority:</strong> scores are weighted percentiles against
        other stocks in the same priority group, not predicted returns. Priority 1 favors benchmark-relative
        performance (30%), positive sentiment conviction (25%), lower volatility (15%), lower beta (10%),
        lower correlation (8%), smaller holding weight (5%), lower sector exposure (4%), and fewer risk flags (3%).
        Priority 2 favors underperformance (25%), negative sentiment conviction (25%), higher volatility (15%),
        beta (10%), correlation (10%), exposure (10%), and risk flags (5%). Priority 3 favors lower volatility
        (35%), beta (15%), correlation (10%), smaller holding and sector exposure (25%), neutral sentiment (10%),
        and relative performance (5%). Missing benchmark returns score neutrally. Lower rank in the group is first.
      </div>

      {loading && !report && <LoadingState message="Analysing risk and sentiment…" />}

      {error && (
        <div className="alert alert-danger" role="alert">
          {error}
        </div>
      )}

      {report && (
        <>
          <div className="row g-4 mb-4">
            {sectorChartData() && (
              <div className="col-lg-5">
                <div className="card border-0 shadow-sm h-100 chart-card">
                  <div className="card-header bg-white border-bottom py-3">
                    <h2 className="h6 mb-0 fw-semibold">Sector allocation</h2>
                  </div>
                  <div className="card-body d-flex align-items-center justify-content-center">
                    <Pie data={sectorChartData()!} />
                  </div>
                </div>
              </div>
            )}
            {volatilityChartData() && (
              <div className="col-lg-7">
                <div className="card border-0 shadow-sm h-100 chart-card">
                  <div className="card-header bg-white border-bottom py-3">
                    <h2 className="h6 mb-0 fw-semibold">Top volatility (annualised %)</h2>
                  </div>
                  <div className="card-body">
                    <Bar
                      data={volatilityChartData()!}
                      options={{ responsive: true, plugins: { legend: { display: false } } }}
                    />
                  </div>
                </div>
              </div>
            )}
          </div>

          {Array.isArray(report.stockSummaries) && (
            <DataTable>
              <thead className="table-light">
                <tr>
                  <SortableTh column="priorityRank" label="Priority" onSort={handleSort} indicator={indicator} />
                  <SortableTh column="categoryRank" label="Rank in group" align="end" onSort={handleSort} indicator={indicator} />
                  <SortableTh column="rankingScore" label="Score / 100" align="end" onSort={handleSort} indicator={indicator} />
                  <SortableTh column="symbol" label="Symbol" onSort={handleSort} indicator={indicator} />
                  <SortableTh column="sector" label="Sector" onSort={handleSort} indicator={indicator} />
                  <SortableTh column="weight" label="Weight %" align="end" onSort={handleSort} indicator={indicator} />
                  <SortableTh column="benchmarkRelativeReturnPct" label={`Vs ${report.benchmarkSymbol ?? "benchmark"} %`} align="end" onSort={handleSort} indicator={indicator} />
                  <SortableTh column="volatilityAnnual" label="Volatility %" align="end" onSort={handleSort} indicator={indicator} />
                  <SortableTh column="beta" label="Beta" align="end" onSort={handleSort} indicator={indicator} />
                  <SortableTh column="sentimentLabel" label="Sentiment" onSort={handleSort} indicator={indicator} />
                  <SortableTh column="recommendedAction" label="Action" onSort={handleSort} indicator={indicator} />
                </tr>
              </thead>
              <tbody>
                {sort(report.stockSummaries).map((s) => (
                  <tr key={s.symbol}>
                    <td>
                      <span className={`badge text-bg-${s.priorityRank === 1 ? "success" : s.priorityRank === 2 ? "danger" : "secondary"}`}>
                        {s.priorityRank} · {s.priorityRank === 1 ? "Increase" : s.priorityRank === 2 ? "Reduce" : "Hold"}
                      </span>
                    </td>
                    <td className="text-end">{s.categoryRank}</td>
                    <td className="text-end">{s.rankingScore.toFixed(1)}</td>
                    <td className="fw-semibold">{s.symbol}</td>
                    <td>{s.sector}</td>
                    <td className="text-end">{s.weight.toFixed(2)}</td>
                    <td className="text-end">{s.benchmarkRelativeReturnPct === null ? "—" : `${s.benchmarkRelativeReturnPct.toFixed(2)}%`}</td>
                    <td className="text-end">{s.volatilityAnnual ?? 0}</td>
                    <td className="text-end">{s.beta ?? "—"}</td>
                    <td>
                      <span className={`badge text-bg-${sentimentBadge(s.sentimentLabel)}`}>
                        {s.sentimentLabel}
                      </span>
                    </td>
                    <td>
                      <span className={`badge text-bg-${actionBadge(s.recommendedAction)}`}>
                        {s.recommendedAction}
                      </span>
                    </td>
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
