import * as React from "react";

type Props = { children: React.ReactNode };

/**
 * Boundary temporário para capturar erros de render e logar stack + árvore de componentes.
 * Remover ou desativar quando o bug de .map estiver resolvido.
 */
export class DebugErrorBoundary extends React.Component<
  Props,
  { error: Error | null; errorInfo: React.ErrorInfo | null }
> {
  state = { error: null as Error | null, errorInfo: null as React.ErrorInfo | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    this.setState({ errorInfo });
    // eslint-disable-next-line no-console
    console.error("[DEBUG ErrorBoundary] caught:", error?.message, error);
    // eslint-disable-next-line no-console
    console.error("[DEBUG ErrorBoundary] stack:", error?.stack);
    // eslint-disable-next-line no-console
    console.error("[DEBUG ErrorBoundary] componentStack:", errorInfo?.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="min-h-screen bg-destructive/10 p-6 text-sm text-foreground">
          <h1 className="mb-2 text-lg font-bold text-destructive">Erro capturado (Debug)</h1>
          <pre className="mb-4 whitespace-pre-wrap break-all rounded border border-border bg-card p-3">
            {this.state.error.message}
            {"\n\n"}
            {this.state.error.stack}
          </pre>
          {this.state.errorInfo?.componentStack ? (
            <pre className="whitespace-pre-wrap break-all rounded border border-border bg-muted/50 p-3 text-xs">
              {this.state.errorInfo.componentStack}
            </pre>
          ) : null}
          <button
            type="button"
            className="mt-4 rounded bg-primary px-4 py-2 text-primary-foreground"
            onClick={() => this.setState({ error: null, errorInfo: null })}
          >
            Tentar continuar
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
