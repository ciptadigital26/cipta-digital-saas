import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider } from "./lib/auth";
import { RequireRole } from "./components/RequireRole";
import Login from "./pages/Login";

// Fasa 2 & 3 akan menggantikan placeholder ini dengan dashboard penuh.
const SuperAdmin = () => <div className="p-8">Super Admin Dashboard — Fasa 2</div>;
const TenantApp = () => <div className="p-8">Tenant Admin Dashboard — Fasa 3</div>;

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/admin/*" element={<RequireRole role="super_admin"><SuperAdmin /></RequireRole>} />
          <Route path="/app/*" element={<RequireRole role="tenant"><TenantApp /></RequireRole>} />
          <Route path="*" element={<Navigate to="/app" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
