import React from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import Layout from "./components/Layout";
import Holdings from "./components/Holdings";
import PnLPage from "./pages/PnL";
import RiskPage from "./pages/Risk";
import RebalancePage from "./pages/Rebalance";
import RecommendPage from "./pages/Recommend";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<Holdings />} />
          <Route path="/pnl" element={<PnLPage />} />
          <Route path="/risk" element={<RiskPage />} />
          <Route path="/recommend" element={<RecommendPage />} />
          <Route path="/rebalance" element={<RebalancePage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
