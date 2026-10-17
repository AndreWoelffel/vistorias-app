import * as React from "react";
import { VERSAO_APP } from "@/lib/pwaUpdate";

type Props = { children: React.ReactNode };

/**
 * Tela de erro de render. O vistoriador vê uma mensagem curta; o detalhe técnico
 * fica escondido em "Detalhes para o suporte" para você pedir um print.
 */
export class DebugErrorBoundary extends React.Component<
  Props,
  { error: Error | null; errorInfo: React.ErrorInfo | null; detalhes: boolean }
> {
  state = { error: null as Error | null, errorInfo: null as React.ErrorInfo | null, detalhes: false };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("[App] Erro de tela:", error, errorInfo.componentStack);
    this.setState({ errorInfo });
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background p-6 text-center">
          <h1 className="text-lg font-bold text-foreground">Algo deu errado nesta tela</h1>
          <p className="max-w-xs text-sm text-muted-foreground">
            As vistorias já salvas continuam guardadas no celular. Volte para o início e tente de novo.
          </p>
          <button
            type="button"
            className="h-12 w-full max-w-xs rounded-xl bg-primary px-4 font-bold text-primary-foreground"
            onClick={() => {
              window.location.href = "/";
            }}
          >
            Voltar para o início
          </button>
          <button
            type="button"
            className="text-xs text-muted-foreground underline"
            onClick={() => this.setState({ detalhes: !this.state.detalhes })}
          >
            Detalhes para o suporte
          </button>
          {this.state.detalhes && (
            <pre className="max-w-full whitespace-pre-wrap break-all rounded border border-border bg-card p-3 text-left text-[10px] text-muted-foreground">
              {`Versão ${VERSAO_APP}\n${this.state.error.message}\n\n${this.state.error.stack ?? ""}`}
            </pre>
          )}
        </div>
      );
    }
    return this.props.children;
  }
}
