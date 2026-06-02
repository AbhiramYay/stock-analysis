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
  const [report, setReport] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const { handleSort, sort, indicator } = useTableSort("volatilityAnnual", "desc");

  async function fetchRisk() {
    setLoading(true);
    try {
      const res = await axios.get(`/api/risk?lookback=${lookback}`);
      setReport(res.data);
    } catch (err: any) {
      setReport({ error: err.message });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchRisk();
  }, []);

  const sectorChartData = () => {
    if (!report?.sectorWeights) return null;
    const entries = Object.entries(report.sectorWeights).sort((a: any, b: any) => b[1] - a[1]);
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
      .sort((a: any, b: any) => b.volatilityAnnual - a.volatilityAnnual)
      .slice(0, 12);
    return {
      labels: items.map((i: any) => i.symbol),
      datasets: [
        {
          label: "Annual Volatility %",
          data: items.map((i: any) => i.volatilityAnnual),
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

      {loading && !report && <LoadingState message="Analysing risk and sentiment…" />}

      {report?.error && (
        <div className="alert alert-danger" role="alert">
          {report.error}
        </div>
      )}

      {report && !report.error && (
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
                  <SortableTh column="symbol" label="Symbol" onSort={handleSort} indicator={indicator} />
                  <SortableTh column="sector" label="Sector" onSort={handleSort} indicator={indicator} />
                  <SortableTh column="weight" label="Weight %" align="end" onSort={handleSort} indicator={indicator} />
                  <SortableTh column="volatilityAnnual" label="Volatility %" align="end" onSort={handleSort} indicator={indicator} />
                  <SortableTh column="beta" label="Beta" align="end" onSort={handleSort} indicator={indicator} />
                  <SortableTh column="sentimentLabel" label="Sentiment" onSort={handleSort} indicator={indicator} />
                  <SortableTh column="recommendedAction" label="Action" onSort={handleSort} indicator={indicator} />
                </tr>
              </thead>
              <tbody>
                {sort(report.stockSummaries).map((s: any) => (
                  <tr key={s.symbol}>
                    <td className="fw-semibold">{s.symbol}</td>
                    <td>{s.sector}</td>
                    <td className="text-end">{s.weight.toFixed(2)}</td>
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
