import React, { useState } from "react";
import axios from "axios";
import { formatPct } from "../utils/format";
import { useTableSort } from "../utils/tableSort";
import PageHeader from "../components/ui/PageHeader";
import LoadingState from "../components/ui/LoadingState";
import DataTable from "../components/ui/DataTable";
import SortableTh from "../components/ui/SortableTh";

type Recommendation = {
  symbol: string;
  sector: string;
  rank: number;
  compositeScore: number;
  fundamentalScore: number;
  sentimentScore: number;
  momentumScore: number;
  sixMonthReturnPct: number | null;
  sentimentLabel: string;
  fundamentalReasoning: string;
  sentimentReasoning: string;
  analystSignals: string[];
  fundamentals: {
    roe: number | null;
    debtToEquity: number | null;
    earningsGrowth: number | null;
    peRatio: number | null;
  };
};

type Report = {
  recommendations: Recommendation[];
  sectorAllocation: Record<string, number>;
  universeScanned: number;
  candidatesPassed: number;
  dataSources: string[];
  methodology: string;
};

function sentimentBadge(label: string) {
  if (label === "positive") return "success";
  if (label === "negative") return "danger";
  return "secondary";
}

export default function RecommendPage() {
  const [topN, setTopN] = useState(8);
  const [includeHoldings, setIncludeHoldings] = useState(true);
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const { handleSort, sort, indicator } = useTableSort("compositeScore", "desc");

  async function fetchRecommendations() {
    setLoading(true);
    setError(null);
    try {
      const res = await axios.get("/api/recommend", {
        params: { top: topN, includeHoldings },
        timeout: 600000,
      });
      setReport(res.data);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Request failed";
      setError(message);
      setReport(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Stock Recommendations (NSE)"
        subtitle="Ranks Nifty 50 large-caps using fundamentals, news and analyst sentiment, and 6-month momentum — diversified across sectors."
      />

      <div className="card border-0 shadow-sm mb-4">
        <div className="card-body">
          <div className="row g-3 align-items-end">
            <div className="col-sm-4 col-md-2">
              <label htmlFor="topN" className="form-label small text-muted mb-1">
                Top picks
              </label>
              <select
                id="topN"
                className="form-select"
                value={topN}
                onChange={(e) => setTopN(Number(e.target.value))}
              >
                {[5, 6, 7, 8, 9, 10].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </div>
            <div className="col-sm-8 col-md-5">
              <div className="form-check mt-4">
                <input
                  className="form-check-input"
                  type="checkbox"
                  id="includeHoldings"
                  checked={includeHoldings}
                  onChange={(e) => setIncludeHoldings(e.target.checked)}
                />
                <label className="form-check-label" htmlFor="includeHoldings">
                  Include portfolio symbols in scan
                </label>
              </div>
            </div>
            <div className="col-auto">
              <button
                type="button"
                className="btn btn-primary"
                onClick={fetchRecommendations}
                disabled={loading}
              >
                {loading ? (
                  <>
                    <span className="spinner-border spinner-border-sm me-2" aria-hidden />
                    Scanning…
                  </>
                ) : (
                  <>
                    <i className="bi bi-search me-1" aria-hidden />
                    Run agent
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      </div>

      {loading && !report && (
        <div className="alert alert-info d-flex align-items-center gap-2" role="status">
          <div className="spinner-border spinner-border-sm" aria-hidden />
          Scanning {includeHoldings ? "Nifty 50 + holdings" : "Nifty 50"} — may take several minutes…
        </div>
      )}

      {error && (
        <div className="alert alert-danger" role="alert">
          <i className="bi bi-exclamation-triangle me-2" aria-hidden />
          {error}
        </div>
      )}

      {report && (
        <>
          <p className="text-muted mb-4">
            Scanned <strong>{report.universeScanned}</strong> symbols ·{" "}
            <strong>{report.candidatesPassed}</strong> passed filters · showing top{" "}
            <strong>{report.recommendations.length}</strong>
          </p>

          {Object.keys(report.sectorAllocation).length > 0 && (
            <div className="card border-0 shadow-sm mb-4">
              <div className="card-header bg-white border-bottom py-3">
                <h2 className="h6 mb-0 fw-semibold">Sector allocation (basket)</h2>
              </div>
              <div className="card-body">
                <div className="row g-3">
                  {Object.entries(report.sectorAllocation)
                    .sort((a, b) => b[1] - a[1])
                    .map(([sector, pct]) => (
                      <div key={sector} className="col-6 col-md-4 col-lg-3">
                        <div className="border rounded-3 p-3 bg-light h-100">
                          <div className="small text-muted text-truncate" title={sector}>
                            {sector}
                          </div>
                          <div className="fs-5 fw-semibold">{pct.toFixed(1)}%</div>
                        </div>
                      </div>
                    ))}
                </div>
              </div>
            </div>
          )}

          <DataTable className="mb-4">
            <thead className="table-light">
              <tr>
                <SortableTh column="rank" label="#" align="end" onSort={handleSort} indicator={indicator} />
                <SortableTh column="symbol" label="Symbol" onSort={handleSort} indicator={indicator} />
                <SortableTh column="sector" label="Sector" onSort={handleSort} indicator={indicator} />
                <SortableTh column="compositeScore" label="Score" align="end" onSort={handleSort} indicator={indicator} />
                <SortableTh column="fundamentalScore" label="Fund." align="end" onSort={handleSort} indicator={indicator} />
                <SortableTh column="sentimentScore" label="Sent." align="end" onSort={handleSort} indicator={indicator} />
                <SortableTh column="momentumScore" label="Mom." align="end" onSort={handleSort} indicator={indicator} />
                <SortableTh column="sentimentLabel" label="Tone" onSort={handleSort} indicator={indicator} />
              </tr>
            </thead>
            <tbody>
              {sort(report.recommendations).map((r) => (
                <tr key={r.symbol}>
                  <td className="text-end text-muted">{r.rank}</td>
                  <td className="fw-semibold">{r.symbol}</td>
                  <td className="small">{r.sector}</td>
                  <td className="text-end fw-bold text-primary">{r.compositeScore.toFixed(1)}</td>
                  <td className="text-end">{r.fundamentalScore}</td>
                  <td className="text-end">{r.sentimentScore}</td>
                  <td className="text-end">{r.momentumScore}</td>
                  <td>
                    <span className={`badge text-bg-${sentimentBadge(r.sentimentLabel)}`}>
                      {r.sentimentLabel}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </DataTable>

          <h2 className="h5 fw-semibold mb-3">Reasoning</h2>
          <div className="row g-3 mb-4">
            {report.recommendations.map((r) => (
              <div key={r.symbol} className="col-12">
                <div className="card border-0 shadow-sm">
                  <div className="card-header bg-white d-flex flex-wrap align-items-center gap-2 py-3">
                    <span className="badge text-bg-primary rounded-pill">#{r.rank}</span>
                    <span className="fw-semibold fs-6">{r.symbol}</span>
                    <span className="text-muted small">{r.sector}</span>
                    <span className="badge text-bg-light border ms-auto">
                      Score {r.compositeScore.toFixed(1)}
                    </span>
                  </div>
                  <div className="card-body">
                    <p className="mb-2">
                      <strong className="text-muted">Fundamentals:</strong> {r.fundamentalReasoning}
                    </p>
                    <p className="mb-2">
                      <strong className="text-muted">Sentiment:</strong> {r.sentimentReasoning}
                    </p>
                    {r.sixMonthReturnPct !== null && (
                      <p className="mb-2 small">
                        <i className="bi bi-graph-up me-1" aria-hidden />
                        6M return:{" "}
                        <span className={r.sixMonthReturnPct >= 0 ? "text-success" : "text-danger"}>
                          {formatPct(r.sixMonthReturnPct)}
                        </span>
                      </p>
                    )}
                    <p className="small text-muted mb-0">
                      {[
                        r.fundamentals.roe !== null ? `ROE ${r.fundamentals.roe.toFixed(1)}%` : null,
                        r.fundamentals.earningsGrowth !== null
                          ? `Growth ${r.fundamentals.earningsGrowth.toFixed(1)}%`
                          : null,
                        r.fundamentals.debtToEquity !== null
                          ? `D/E ${r.fundamentals.debtToEquity.toFixed(2)}`
                          : null,
                        r.fundamentals.peRatio !== null
                          ? `P/E ${r.fundamentals.peRatio.toFixed(1)}`
                          : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                    {r.analystSignals.length > 0 && (
                      <ul className="list-group list-group-flush mt-3 small">
                        {r.analystSignals.map((h, i) => (
                          <li key={i} className="list-group-item px-0 text-muted">
                            <i className="bi bi-newspaper me-2" aria-hidden />
                            {h}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div className="accordion" id="methodologyAccordion">
            <div className="accordion-item border-0 shadow-sm">
              <h2 className="accordion-header">
                <button
                  className="accordion-button collapsed"
                  type="button"
                  data-bs-toggle="collapse"
                  data-bs-target="#methodologyBody"
                >
                  Methodology & data sources
                </button>
              </h2>
              <div id="methodologyBody" className="accordion-collapse collapse" data-bs-parent="#methodologyAccordion">
                <div className="accordion-body">
                  <p className="text-muted">{report.methodology}</p>
                  <ul className="mb-0">
                    {report.dataSources.map((s) => (
                      <li key={s}>{s}</li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </>
  );
}
