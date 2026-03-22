import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import AuthPage from "./pages/AuthPage";
import Home from "./pages/Home";
import Dashboard from "./pages/Dashboard";
import NewInspection from "./pages/NewInspection";
import HistoryPage from "./pages/HistoryPage";
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
          <Route path="/leiloes" element={<ProtectedRoute><LeiloesPage /></ProtectedRoute>} />
          <Route path="/usuarios" element={<AdminRoute><UsuariosPage /></AdminRoute>} />
          <Route path="/dashboard/:leilaoId" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
          <Route path="/vistoria/:leilaoId" element={<ProtectedRoute><NewInspection /></ProtectedRoute>} />
          <Route path="/historico/:leilaoId" element={<ProtectedRoute><HistoryPage /></ProtectedRoute>} />
          <Route path="/editar/:id" element={<ProtectedRoute><EditInspection /></ProtectedRoute>} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
