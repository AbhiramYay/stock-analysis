import React, { useState } from "react";
import axios from "axios";
import { formatINR, formatPct } from "../utils/format";
import { useTableSort } from "../utils/tableSort";
import PageHeader from "../components/ui/PageHeader";
import DataTable from "../components/ui/DataTable";
import SortableTh from "../components/ui/SortableTh";

type TradeSuggestion = {
  symbol: string;
  action: "BUY" | "SELL";
  quantity: number;
  estimatedPrice: number;
  estimatedValue: number;
  currentWeight: number;
  targetWeight: number;
  weightDelta: number;
};

type RebalancingPlan = {
  suggestions: TradeSuggestion[];
  totalBuyValue: number;
  totalSellValue: number;
  netCashRequired: number;
  weightDriftThreshold: number;
  skippedSymbols: string[];
};

export default function RebalancePage() {
  const [targetStr, setTargetStr] = useState("INFY:30,TCS:40,HDFC:30");
  const [plan, setPlan] = useState<RebalancingPlan | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [token, setToken] = useState("");
  const [executeResult, setExecuteResult] = useState<any>(null);
  const { handleSort, sort, indicator } = useTableSort("weightDelta", "desc");

  async function computePlan(e?: React.FormEvent) {
    e?.preventDefault();
    setLoading(true);
    setPlanError(null);
    try {
      const res = await axios.post("/api/rebalance", { targetWeightsStr: targetStr });
      setPlan(res.data.plan);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Request failed";
      setPlan(null);
      setPlanError(message);
    } finally {
      setLoading(false);
    }
  }

  async function executePlan() {
    if (!confirm("Execute rebalance using provided ADMIN token?")) return;
    setLoading(true);
    try {
      const res = await axios.post(
        "/api/rebalance/execute",
        { targetWeightsStr: targetStr },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      setExecuteResult(res.data);
    } catch (err: any) {
      setExecuteResult({ error: err.message });
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Rebalance Planner"
        subtitle="Compute BUY/SELL trades to match target weights. Dry-run by default until you execute with an admin token."
      />

      <div className="card border-0 shadow-sm mb-4">
        <div className="card-body">
          <form onSubmit={computePlan}>
            <label htmlFor="targets" className="form-label fw-medium">
              Target weights
            </label>
            <div className="input-group mb-2">
              <input
                id="targets"
                type="text"
                className="form-control font-monospace"
                value={targetStr}
                onChange={(e) => setTargetStr(e.target.value)}
                placeholder="INFY:30,TCS:40,HDFC:30"
              />
              <button type="submit" className="btn btn-primary" disabled={loading}>
                {loading ? (
                  <span className="spinner-border spinner-border-sm" aria-hidden />
                ) : (
                  "Compute plan"
                )}
              </button>
            </div>
            <div className="form-text">Format: SYMBOL:weight pairs separated by commas</div>
          </form>
        </div>
      </div>

      {planError && (
        <div className="alert alert-danger" role="alert">
          {planError}
        </div>
      )}

      {plan && (
        <>
          {plan.suggestions.length === 0 ? (
            <div className="alert alert-success" role="alert">
              <i className="bi bi-check-circle me-2" aria-hidden />
              Portfolio is within the drift threshold. No trades needed.
              {plan.skippedSymbols.length > 0 && (
                <div className="small mt-2 text-muted">
                  Skipped (below {plan.weightDriftThreshold}% drift):{" "}
                  {plan.skippedSymbols.join(", ")}
                </div>
              )}
            </div>
          ) : (
            <>
              <DataTable className="mb-4">
                <thead className="table-light">
                  <tr>
                    <SortableTh column="action" label="Action" onSort={handleSort} indicator={indicator} />
                    <SortableTh column="symbol" label="Symbol" onSort={handleSort} indicator={indicator} />
                    <SortableTh column="quantity" label="Qty" align="end" onSort={handleSort} indicator={indicator} />
                    <SortableTh column="estimatedPrice" label="Price ₹" align="end" onSort={handleSort} indicator={indicator} />
                    <SortableTh column="estimatedValue" label="Value ₹" align="end" onSort={handleSort} indicator={indicator} />
                    <SortableTh column="currentWeight" label="Current %" align="end" onSort={handleSort} indicator={indicator} />
                    <SortableTh column="targetWeight" label="Target %" align="end" onSort={handleSort} indicator={indicator} />
                    <SortableTh column="weightDelta" label="Drift" align="end" onSort={handleSort} indicator={indicator} />
                  </tr>
                </thead>
                <tbody>
                  {sort(plan.suggestions).map((s) => (
                    <tr key={`${s.action}-${s.symbol}`}>
                      <td>
                        <span
                          className={`badge ${s.action === "BUY" ? "text-bg-success" : "text-bg-danger"}`}
                        >
                          {s.action}
                        </span>
                      </td>
                      <td className="fw-semibold">{s.symbol}</td>
                      <td className="text-end">{s.quantity}</td>
                      <td className="text-end">{formatINR(s.estimatedPrice)}</td>
                      <td className="text-end">{formatINR(s.estimatedValue)}</td>
                      <td className="text-end">{s.currentWeight.toFixed(1)}%</td>
                      <td className="text-end">{s.targetWeight.toFixed(1)}%</td>
                      <td className="text-end fw-medium">{formatPct(s.weightDelta)}</td>
                    </tr>
                  ))}
                </tbody>
              </DataTable>

              <div className="card border-0 shadow-sm mb-4">
                <div className="card-header bg-white border-bottom py-3">
                  <h2 className="h6 mb-0 fw-semibold">Summary</h2>
                </div>
                <div className="card-body">
                  <ul className="list-group list-group-flush">
                    <li className="list-group-item d-flex justify-content-between px-0">
                      <span>Total BUY value</span>
                      <strong className="text-success">{formatINR(plan.totalBuyValue)}</strong>
                    </li>
                    <li className="list-group-item d-flex justify-content-between px-0">
                      <span>Total SELL value</span>
                      <strong className="text-danger">{formatINR(plan.totalSellValue)}</strong>
                    </li>
                    <li className="list-group-item d-flex justify-content-between px-0">
                      <span>{plan.netCashRequired >= 0 ? "Cash required" : "Cash freed up"}</span>
                      <strong>{formatINR(Math.abs(plan.netCashRequired))}</strong>
                    </li>
                  </ul>
                  {plan.skippedSymbols.length > 0 && (
                    <p className="small text-muted mb-0 mt-3">
                      Skipped (drift &lt; {plan.weightDriftThreshold}%): {plan.skippedSymbols.join(", ")}
                    </p>
                  )}
                </div>
              </div>
            </>
          )}
        </>
      )}

      <div className="card border-0 shadow-sm border-warning-subtle">
        <div className="card-header bg-warning-subtle border-0 py-3">
          <h2 className="h6 mb-0 fw-semibold">
            <i className="bi bi-lightning-charge me-2" aria-hidden />
            Execute trades
          </h2>
        </div>
        <div className="card-body">
          <p className="text-muted small">
            Server must have <code>ADMIN_API_TOKEN</code> set. Places real orders on Zerodha.
          </p>
          <div className="row g-2 align-items-stretch">
            <div className="col-md-8">
              <input
                type="password"
                className="form-control"
                placeholder="ADMIN API token"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                autoComplete="off"
              />
            </div>
            <div className="col-md-4">
              <button
                type="button"
                className="btn btn-warning w-100"
                onClick={executePlan}
                disabled={loading || !token}
              >
                Execute rebalance
              </button>
            </div>
          </div>

          {executeResult && (
            <div className="mt-4">
              <h3 className="h6 fw-semibold mb-2">Execution result</h3>
              <pre className="json-result bg-light border rounded p-3 mb-0">
                {JSON.stringify(executeResult, null, 2)}
              </pre>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
