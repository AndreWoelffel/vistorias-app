import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate, useParams } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { SIMPLE_MODE } from "@/config/appMode";
import AuthPage from "./pages/AuthPage";
import Home from "./pages/Home";
// ─── MODO COMPLETO: descomente os 3 imports abaixo ───────────────────────────
// import Dashboard from "./pages/Dashboard";
import NewInspection from "./pages/NewInspection";
// import HistoryPage from "./pages/HistoryPage";
// import DuplicidadesPage from "./pages/DuplicidadesPage";
import EditInspection from "./pages/EditInspection";
import LeiloesPage from "./pages/LeiloesPage";
import UsuariosPage from "./pages/UsuariosPage";
import NotFound from "./pages/NotFound";
import { SyncBridge } from "@/components/SyncBridge";
import { SyncNotifications } from "@/components/SyncNotifications";
import { OfflineNotice } from "@/components/OfflineNotice";
import { InstallPwaPrompt } from "@/components/InstallPwaPrompt";

const queryClient = new QueryClient();

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated } = useAuth();
  if (!isAuthenticated) return <Navigate to="/auth" replace />;
  return <>{children}</>;
}

function AdminRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, user } = useAuth();
  if (!isAuthenticated) return <Navigate to="/auth" replace />;
  if (user?.role !== 'admin') return <Navigate to="/" replace />;
  return <>{children}</>;
}

/** MODO SIMPLES: redireciona /dashboard/:id → /vistoria/:id (links antigos). */
function DashboardRedirect() {
  const { leilaoId } = useParams();
  return <Navigate to={`/vistoria/${leilaoId}`} replace />;
}

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <OfflineNotice />
        <SyncBridge />
        <SyncNotifications />
        <InstallPwaPrompt />
        <Routes>
          <Route path="/auth" element={<AuthPage />} />
          <Route path="/" element={<ProtectedRoute><Home /></ProtectedRoute>} />
          <Route path="/leiloes" element={<AdminRoute><LeiloesPage /></AdminRoute>} />
          <Route path="/usuarios" element={<AdminRoute><UsuariosPage /></AdminRoute>} />
          {/* ─── MODO COMPLETO: substitua DashboardRedirect pela rota do Dashboard ──
          <Route path="/dashboard/:leilaoId" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
          <Route path="/historico/:leilaoId" element={<ProtectedRoute><HistoryPage /></ProtectedRoute>} />
          <Route path="/duplicidades/:leilaoId" element={<ProtectedRoute><DuplicidadesPage /></ProtectedRoute>} />
          ─── fim MODO COMPLETO ─── */}
          {SIMPLE_MODE && (
            <Route path="/dashboard/:leilaoId" element={<ProtectedRoute><DashboardRedirect /></ProtectedRoute>} />
          )}
          <Route path="/vistoria/:leilaoId" element={<ProtectedRoute><NewInspection /></ProtectedRoute>} />
          <Route path="/editar/:id" element={<ProtectedRoute><EditInspection /></ProtectedRoute>} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
