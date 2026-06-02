import React from "react";

export default function LoadingState({ message = "Loading…" }: { message?: string }) {
  return (
    <div className="d-flex align-items-center gap-3 py-5 text-muted" role="status">
      <div className="spinner-border text-primary" aria-hidden />
      <span>{message}</span>
    </div>
  );
}
