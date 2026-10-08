import "./Report.css";

export function ReportPage() {
  return (
    <section className="report-view">
      <div className="report-panel">
        <div className="report-panel-header">
          <div className="report-title">
            <span className="node-mark" />
            <h2>Report</h2>
          </div>
        </div>
        <div className="report-empty">
          <p>No tasks available</p>
        </div>
      </div>
    </section>
  );
}
