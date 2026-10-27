import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { ErrorBanner } from "./ui";

type Props = { children: ReactNode; active?: boolean };

// Catches a crash inside one page, so the sidebar and the other pages keep
// working. Retry draws the page again. A page that stays mounted while hidden
// (Today) passes active, so its error only shows on its own page.
export class PageBoundary extends Component<Props, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("A page crashed:", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.active === false) return null;
    return (
      <div className="page">
        <header className="page-head">
          <div className="page-title">
            <h1>This page hit an error</h1>
            <p className="lede">The rest of the app still works. Try again, or pick another page.</p>
          </div>
        </header>
        <div className="page-body">
          <ErrorBanner message={error.message || "Something went wrong."} onRetry={() => this.setState({ error: null })} />
        </div>
      </div>
    );
  }
}
