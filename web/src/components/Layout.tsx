import React from "react";
import { NavLink, Outlet } from "react-router-dom";

const navItems = [
  { to: "/", label: "Holdings", icon: "bi-wallet2", end: true },
  { to: "/pnl", label: "PnL", icon: "bi-graph-up-arrow" },
  { to: "/risk", label: "Risk", icon: "bi-shield-exclamation" },
  { to: "/recommend", label: "Recommend", icon: "bi-stars" },
  { to: "/rebalance", label: "Rebalance", icon: "bi-sliders" },
];

export default function Layout() {
  return (
    <div className="app-shell min-vh-100 d-flex flex-column">
      <nav className="navbar navbar-expand-lg navbar-dark bg-primary shadow-sm sticky-top">
        <div className="container-fluid container-xl">
          <NavLink className="navbar-brand fw-semibold d-flex align-items-center gap-2" to="/">
            <i className="bi bi-bar-chart-line-fill" aria-hidden />
            Stock Analysis
          </NavLink>
          <button
            className="navbar-toggler"
            type="button"
            data-bs-toggle="collapse"
            data-bs-target="#mainNav"
            aria-controls="mainNav"
            aria-expanded="false"
            aria-label="Toggle navigation"
          >
            <span className="navbar-toggler-icon" />
          </button>
          <div className="collapse navbar-collapse" id="mainNav">
            <ul className="navbar-nav ms-auto gap-lg-1">
              {navItems.map((item) => (
                <li className="nav-item" key={item.to}>
                  <NavLink
                    to={item.to}
                    end={item.end}
                    className={({ isActive }) =>
                      `nav-link d-flex align-items-center gap-2 rounded px-3${isActive ? " active" : ""}`
                    }
                  >
                    <i className={`bi ${item.icon}`} aria-hidden />
                    {item.label}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </nav>

      <main className="flex-grow-1 py-4">
        <div className="container-fluid container-xl">
          <Outlet />
        </div>
      </main>

      <footer className="border-top bg-white py-3 mt-auto">
        <div className="container-fluid container-xl text-muted small text-center">
          Zerodha portfolio tools · Not investment advice
        </div>
      </footer>
    </div>
  );
}
