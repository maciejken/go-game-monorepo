import { Navigate, Route, Routes } from 'react-router-dom'
import Home from './pages/Home'
import Game from './pages/Game'
import Auth from './pages/Auth'
import Profile from './pages/Profile'
import Reports, { ReportDetails } from './pages/Reports'
import Performance from './pages/Performance'
import { AuthProvider } from './hooks/AuthProvider'
import { DialogProvider } from './hooks/DialogProvider'
import './App.css'

function App() {
  return (
    <DialogProvider>
      <AuthProvider>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/login" element={<Auth />} />
          <Route path="/games/:id" element={<Game />} />
          <Route path="/games/:id/performance" element={<Performance />} />
          <Route path="/profile/:id" element={<Profile />} />
          {/* Admin only, and unlinked: the server decides, the page just
              shows what it answers. */}
          <Route path="/reports" element={<Reports />} />
          <Route path="/reports/:id" element={<ReportDetails />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </DialogProvider>
  )
}

export default App
